import hashlib
import json
import os
import re
from datetime import date, timedelta, datetime, timezone
from uuid import UUID

import boto3
from botocore.exceptions import ClientError

dynamodb = boto3.client("dynamodb")
SUPPORT_TYPES = {"checkin", "connection", "language", "baggage", "arrival", "company"}
SCOPES = {
    "", "Departure airport only", "A connecting airport only",
    "Arrival airport only", "Throughout the journey",
}
TRAVELERS = {"", "Myself", "A family member or friend"}


def reply(status, **body):
    return {
        "statusCode": status,
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
    return {
        "id": raw_id, "role": role, "from": departure, "to": arrival, "date": travel_date,
        "name": field(payload, "name", 40, required=True),
        "email": field(payload, "email", 254, r"[^\s@]+@[^\s@]+\.[^\s@]+", True),
        "language": field(payload, "language", 50, required=True),
        "flight": field(payload, "flight", 15, r"[A-Z0-9 -]+"),
        "connection": field(payload, "connection", 3, r"[A-Z]{3}"),
        "support": sorted(set(support)), "flex": flex, "help": notes,
        "scope": scope, "traveler": traveler,
    }


def handler(event, context):
    body = event.get("body") or ""
    if len(body) > 8192:
        return reply(413, message="Registration is too large.")
    if event.get("isBase64Encoded"):
        return reply(415, message="Send JSON.")
    try:
        record = validate(json.loads(body))
    except ValueError as error:
        message = "Send valid JSON." if isinstance(error, json.JSONDecodeError) else str(error)
        return reply(400, message=message)

    fingerprint = hashlib.sha256(json.dumps(record, sort_keys=True).encode()).hexdigest()
    item = {key: {"S": value} for key, value in record.items() if isinstance(value, str) and value}
    item.update(
        flex={"N": str(record["flex"])},
        support={"L": [{"S": value} for value in record["support"]]},
        fingerprint={"S": fingerprint},
        createdAt={"S": datetime.now(timezone.utc).isoformat()},
    )
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
