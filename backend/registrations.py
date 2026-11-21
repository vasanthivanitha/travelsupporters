import hashlib
import json
import logging
import os
import re
import unicodedata
from datetime import date, timedelta, datetime, timezone
from uuid import UUID

import boto3
from botocore.exceptions import ClientError

dynamodb = boto3.client("dynamodb")
logger = logging.getLogger(__name__)
SUPPORT_TYPES = {"checkin", "connection", "language", "baggage", "arrival", "company"}
SCOPES = {
    "", "Departure airport only", "A connecting airport only",
    "Arrival airport only", "Throughout the journey",
}
TRAVELERS = {"", "Myself", "A family member or friend"}


def reply(status_code, **body):
    return {
        "statusCode": status_code,
        "headers": {"Content-Type": "application/json", "Cache-Control": "no-store"},
        "body": json.dumps(body),
    }


def field(payload, name, limit, pattern=None, required=False):
    raw = payload.get(name, "")
    if not isinstance(raw, str):
        raise ValueError(f"Check the {name} field.")
    value = raw.strip()
    if len(value) > limit or (required and not value) or (value and pattern and not re.fullmatch(pattern, value)):
        raise ValueError(f"Check the {name} field.")
    return value


def validate(payload):
    if not isinstance(payload, dict):
        raise ValueError("Send a registration object.")
    raw_id = field(payload, "id", 36, required=True)
    identifier = UUID(raw_id)
    if identifier.version != 4 or str(identifier) != raw_id:
        raise ValueError("Check the registration ID.")
    role = field(payload, "role", 7, r"request|offer", True)
    departure = field(payload, "from", 3, r"[A-Z]{3}", True)
    arrival = field(payload, "to", 3, r"[A-Z]{3}", True)
    if departure == arrival:
        raise ValueError("Choose different departure and arrival airports.")
    travel_date = field(payload, "date", 10, r"\d{4}-\d{2}-\d{2}", True)
    if date.fromisoformat(travel_date) < datetime.now(timezone.utc).date() - timedelta(days=1):
        raise ValueError("Choose an upcoming travel date.")
    support = payload.get("support", [])
    if not isinstance(support, list) or len(support) > len(SUPPORT_TYPES) or any(
        not isinstance(value, str) or value not in SUPPORT_TYPES for value in support
    ):
        raise ValueError("Choose a valid type of help.")
    flex = payload.get("flex", 0)
    if type(flex) is not int or flex not in (0, 1, 3):
        raise ValueError("Choose a valid date flexibility option.")
    notes = field(payload, "help", 240)
    if not notes and not support:
        raise ValueError("Choose a type of help or add a note.")
    scope = field(payload, "scope", 32)
    traveler = field(payload, "traveler", 30)
    if scope not in SCOPES or traveler not in TRAVELERS or (role == "request" and scope) or (role == "offer" and traveler):
        raise ValueError("Check the details for this registration type.")
    record = {
        "id": raw_id, "role": role, "from": departure, "to": arrival, "date": travel_date,
        "name": field(payload, "name", 100, required=True),
        "email": field(payload, "email", 254, r"[^\s@]+@[^\s@]+\.[^\s@]+", True),
        "language": field(payload, "language", 50, required=True),
        "flight": field(payload, "flight", 15, r"[A-Z0-9 -]+"),
        "connection": field(payload, "connection", 3, r"[A-Z]{3}"),
        "support": sorted(set(support)), "flex": flex, "help": notes,
        "scope": scope, "traveler": traveler,
    }

    optional_fields = {
        "phoneAbroad": (25, r"[+0-9(). -]+"),
        "phoneIndia": (25, r"[+0-9(). -]+"),
        "direction": (8, r"inbound|outbound"),
        "airline": (80, None),
        "fromCity": (80, None),
        "toCity": (80, None),
        "departureTime": (5, r"(?:[01]\d|2[0-3]):[0-5]\d"),
        "connectingFlight1": (40, None),
        "connectingFlight2": (40, None),
        "elder": (3, r"yes|no"),
        "payment": (6, r"free|charge"),
    }
    for key, (limit, pattern) in optional_fields.items():
        value = field(payload, key, limit, pattern)
        if value:
            record[key] = value
    for key in ("phoneAbroad", "phoneIndia"):
        if key in record and not 7 <= sum(char.isdigit() for char in record[key]) <= 15:
            raise ValueError("Enter a contact number with 7 to 15 digits.")
    if role == "request" and ("elder" in record or "payment" in record):
        raise ValueError("Supporter preferences apply to offers.")
    return record


def public_trip_details(table, items):
    if not items:
        return {}
    try:
        result = dynamodb.batch_get_item(RequestItems={
            table: {
                "Keys": [{"id": item["id"]} for item in items],
                "ProjectionExpression": "#id, #language, #confirmed",
                "ExpressionAttributeNames": {"#id": "id", "#language": "publicLanguage", "#confirmed": "matchConfirmed"},
            }
        })
    except ClientError as error:
        logger.warning("Public language lookup failed: code=%s", error.response.get("Error", {}).get("Code"))
        return {}
    return {
        item["id"]["S"]: item
        for item in result["Responses"].get(table, [])
    }


def list_trips(event):
    params = event.get("queryStringParameters") or {}
    current_date = datetime.now(timezone.utc).date()
    today = current_date.isoformat()
    query = {
        "TableName": os.environ["TABLE_NAME"],
        "IndexName": "PublicTrips",
        "KeyConditionExpression": "#listing = :public AND #date >= :today",
        "ExpressionAttributeNames": {"#listing": "listing", "#date": "date"},
        "ExpressionAttributeValues": {":public": {"S": "PUBLIC"}, ":today": {"S": today}},
        "Limit": 50,
    }
    conditions = []
    for key, pattern in (("from", r"[A-Z]{3}"), ("to", r"[A-Z]{3}"), ("role", r"request|offer")):
        if value := params.get(key):
            if not re.fullmatch(pattern, value):
                return reply(400, message="Invalid trip board filter.")
            query["ExpressionAttributeNames"]["#" + key] = key
            query["ExpressionAttributeValues"][":" + key] = {"S": value}
            conditions.append(f"#{key} = :{key}")
    if support := params.get("support"):
        if support not in SUPPORT_TYPES:
            return reply(400, message="Invalid type of help.")
        query["ExpressionAttributeNames"]["#support"] = "support"
        query["ExpressionAttributeValues"][":support"] = {"S": support}
        conditions.append("contains(#support, :support)")
    if conditions:
        query["FilterExpression"] = " AND ".join(conditions)
    if cursor := params.get("after"):
        try:
            cursor_date, cursor_id = cursor.split("/", 1)
            if date.fromisoformat(cursor_date).isoformat() != cursor_date or str(UUID(cursor_id)) != cursor_id:
                raise ValueError
        except ValueError:
            return reply(400, message="Invalid trip board cursor.")
        query["ExclusiveStartKey"] = {
            "listing": {"S": "PUBLIC"}, "date": {"S": cursor_date}, "id": {"S": cursor_id}
        }
    try:
        results = dynamodb.query(**query)
    except ClientError as error:
        logger.warning(
            "PublicTrips query failed: code=%s aws_request_id=%s",
            error.response.get("Error", {}).get("Code", "unknown"),
            error.response.get("ResponseMetadata", {}).get("RequestId", "unknown"),
        )
        return reply(503, message="The trip board is temporarily unavailable. Try again.")
    items = results.get("Items", [])
    details = public_trip_details(query["TableName"], items)
    urgent_through = (current_date + timedelta(days=7)).isoformat()
    trips = [
        {
            **{key: item[key]["S"] for key in ("role", "from", "to", "date")},
            "support": [value["S"] for value in item.get("support", {}).get("L", [])],
            "language": details.get(item["id"]["S"], {}).get("publicLanguage", {}).get("S"),
            "reference": item["id"]["S"],
            "urgent": item["role"]["S"] == "request" and item["id"]["S"] in details and item["date"]["S"] <= urgent_through
                      and not details.get(item["id"]["S"], {}).get("matchConfirmed", {}).get("BOOL", False),
            "seekingSupport": item["role"]["S"] == "request" and item["id"]["S"] in details
                              and not details.get(item["id"]["S"], {}).get("matchConfirmed", {}).get("BOOL", False),
        }
        for item in items
    ]
    last = results.get("LastEvaluatedKey")
    return reply(200, trips=trips, after=last["date"]["S"] + "/" + last["id"]["S"] if last else None)


def handler(event, context):
    if event.get("requestContext", {}).get("http", {}).get("method") == "GET":
        return list_trips(event)
    body = event.get("body") or ""
    if len(body) > 8192:
        return reply(413, message="Registration is too large.")
    if event.get("isBase64Encoded"):
        return reply(415, message="Send JSON.")
    try:
        payload = json.loads(body)
        record = validate(payload)
        publish = payload.get("publish", False)
        share_language = payload.get("shareLanguage", False)
        if type(publish) is not bool or type(share_language) is not bool or (share_language and not publish):
            raise ValueError("Check the trip board preferences.")
        target = field(payload, "requestReference", 36)
        if target:
            if record["role"] != "offer" or str(UUID(target)) != target:
                raise ValueError("Invalid companion request reference.")
            names = {f"#{key}": key for key in ("id", "role", "from", "to", "date", "listing", "matchConfirmed")}
            item = dynamodb.get_item(TableName=os.environ["TABLE_NAME"], Key={"id": {"S": target}},
                                     ConsistentRead=True, ProjectionExpression=", ".join(names),
                                     ExpressionAttributeNames=names).get("Item", {})
            if (item.get("role", {}).get("S") != "request" or item.get("listing", {}).get("S") != "PUBLIC"
                or item.get("matchConfirmed", {}).get("BOOL") or
                any(item.get(key, {}).get("S") != record[key] for key in ("from", "to", "date"))):
                return reply(409, message="This request or its route has changed. Go back to the trip board and choose an open request.")
            record["requestReference"] = target
        manage_token = payload.get("manageToken", "")
        if not isinstance(manage_token, str) or (manage_token and not re.fullmatch(r"[A-Za-z0-9_-]{43}", manage_token)):
            raise ValueError("Invalid private trip token.")
        if manage_token:
            record["manageHash"] = hashlib.sha256(manage_token.encode()).hexdigest()
        if share_language:
            language = record["language"]
            if any(not (char.isalpha() or unicodedata.category(char).startswith("M") or char in " ,-'’") for char in language):
                raise ValueError("Enter only language names separated by commas to share them publicly.")
            record["publicLanguage"] = language
    except ClientError:
        return reply(503, message="The linked request could not be verified. Try again.")
    except ValueError as error:
        message = "Send valid JSON." if isinstance(error, json.JSONDecodeError) else str(error)
        return reply(400, message=message)

    fingerprint_data = {**record, "publish": True} if publish else record
    fingerprint = hashlib.sha256(json.dumps(fingerprint_data, sort_keys=True).encode()).hexdigest()
    item = {key: {"S": value} for key, value in record.items() if isinstance(value, str) and value}
    item.update(
        flex={"N": str(record["flex"])},
        support={"L": [{"S": value} for value in record["support"]]},
        fingerprint={"S": fingerprint},
        createdAt={"S": datetime.now(timezone.utc).isoformat()},
    )
    if publish:
        item["listing"] = {"S": "PUBLIC"}
    try:
        dynamodb.put_item(
            TableName=os.environ["TABLE_NAME"], Item=item,
            ConditionExpression="attribute_not_exists(id)",
            ReturnValuesOnConditionCheckFailure="ALL_OLD",
        )
    except ClientError as error:
        if error.response["Error"]["Code"] == "ConditionalCheckFailedException":
            previous = error.response.get("Item", {}).get("fingerprint", {}).get("S")
            if previous == fingerprint:
                return reply(200, id=record["id"])
            return reply(409, message="This registration ID has already been used.")
        return reply(503, message="Registration is temporarily unavailable. Try again.")
    return reply(201, id=record["id"])
