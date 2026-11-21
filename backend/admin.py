import json
import logging
import os
import re
from datetime import date, timedelta
from uuid import UUID

from botocore.exceptions import ClientError

from registrations import SUPPORT_TYPES, dynamodb, reply

logger = logging.getLogger(__name__)


def registration_id(value):
    if not isinstance(value, str) or len(value) != 36 or str(UUID(value)) != value:
        raise ValueError("Enter a valid registration reference.")
    return value


def review(event, table):
    names = {f"#{key}": key for key in ("id", "role", "from", "to", "date", "listing", "withdrawn")}
    query = {
        "TableName": table, "Limit": 50, "ConsistentRead": True,
        "ProjectionExpression": ", ".join(names), "ExpressionAttributeNames": names,
    }
    if cursor := (event.get("queryStringParameters") or {}).get("after"):
        query["ExclusiveStartKey"] = {"id": {"S": registration_id(cursor)}}
    result = dynamodb.scan(**query)
    items = [
        {
            **{key: record.get(key, {}).get("S", "") for key in ("id", "role", "from", "to", "date")},
            "published": record.get("listing", {}).get("S") == "PUBLIC",
            "withdrawn": record.get("withdrawn", {}).get("BOOL", False),
        }
        for record in result.get("Items", [])
    ]
    next_key = result.get("LastEvaluatedKey")
    return reply(200, registrations=items, after=next_key["id"]["S"] if next_key else None)


def text(item, key):
    return item.get(key, {}).get("S", "")


def categories(item):
    return {entry["S"] for entry in item.get("support", {}).get("L", [])} & SUPPORT_TYPES


def normalized_flight(item, key):
    return re.sub(r"[^A-Z0-9]", "", text(item, key).upper())


def spoken_languages(item):
    return {word.strip().casefold() for word in re.split(r"[,;/]|\band\b|\bor\b", text(item, "language")) if word.strip()}


def flexibility(item):
    return min(3, max(0, int(item.get("flex", {}).get("N", "0"))))


def find_supporters(table, identifier):
    fields = ("id", "role", "from", "to", "date", "flight", "connection", "connectingFlight1",
              "connectingFlight2", "flex", "language", "support")
    names = {f"#{key}": key for key in fields}
    request = dynamodb.get_item(
        TableName=table, Key={"id": {"S": registration_id(identifier)}},
        ProjectionExpression=", ".join(names), ExpressionAttributeNames=names,
    ).get("Item", {})
    if text(request, "role") != "request":
        return reply(404, message="Companion request not found.")
    requested_date = date.fromisoformat(text(request, "date"))
    window = timedelta(days=flexibility(request) + 3)
    offer_names = {**names, "#email": "email", "#withdrawn": "withdrawn"}
    scan = {
        "TableName": table,
        "ProjectionExpression": ", ".join(offer_names),
        "ExpressionAttributeNames": offer_names,
        "FilterExpression": "#role = :offer AND #from = :from AND #to = :to AND #date BETWEEN :start AND :end AND attribute_not_exists(#withdrawn)",
        "ExpressionAttributeValues": {
            ":offer": {"S": "offer"}, ":from": request["from"], ":to": request["to"],
            ":start": {"S": (requested_date - window).isoformat()},
            ":end": {"S": (requested_date + window).isoformat()},
        },
    }
    matches = []
    while True:
        page = dynamodb.scan(**scan)
        for offer in page.get("Items", []):
            days = abs((date.fromisoformat(text(offer, "date")) - requested_date).days)
            if days > flexibility(request) + flexibility(offer):
                continue
            flight = normalized_flight(request, "flight")
            same_flight = bool(flight and flight == normalized_flight(offer, "flight") and days == 0)
            connections_differ = any(
                text(request, key) and text(offer, key) and
                normalized_flight(request, key) != normalized_flight(offer, key)
                for key in ("connection", "connectingFlight1", "connectingFlight2")
            )
            help_in_common = sorted(categories(offer) & categories(request))
            language_in_common = sorted(spoken_languages(offer) & spoken_languages(request))
            match = {
                "id": text(offer, "id"), "date": text(offer, "date"), "email": text(offer, "email"),
                "sameFlight": same_flight, "connectionDiffers": connections_differ,
                "helpInCommon": help_in_common, "languagesInCommon": language_in_common,
            }
            matches.append(((not same_flight, days, connections_differ, -len(help_in_common), -len(language_in_common)), match))
        if not page.get("LastEvaluatedKey"):
            break
        scan["ExclusiveStartKey"] = page["LastEvaluatedKey"]
    matches.sort(key=lambda entry: entry[0])
    return reply(200, matches=[entry[1] for entry in matches[:25]], total=len(matches),
                 requestedHelp=sorted(categories(request)))


def change_listing(event, table):
    body = event.get("body") or ""
    if event.get("isBase64Encoded") or len(body) > 2048:
        return reply(400, message="Invalid listing change.")
    data = json.loads(body)
    if not isinstance(data, dict) or type(data.get("published")) is not bool:
        raise ValueError("Choose whether to publish or unlist.")
    identifier = registration_id(data.get("id"))
    published = data["published"]
    update = {
        "TableName": table,
        "Key": {"id": {"S": identifier}},
        "ConditionExpression": "attribute_exists(#id) AND attribute_not_exists(#withdrawn)",
        "ExpressionAttributeNames": {"#id": "id", "#listing": "listing", "#withdrawn": "withdrawn"},
        "UpdateExpression": "SET #listing = :public" if published else "REMOVE #listing",
    }
    if published:
        update["ExpressionAttributeValues"] = {":public": {"S": "PUBLIC"}}
    dynamodb.update_item(**update)
    return reply(200, id=identifier, published=published)


def handler(event, context):
    request = event.get("requestContext", {})
    claims = request.get("authorizer", {}).get("jwt", {}).get("claims", {})
    if claims.get("token_use") != "access" or not claims.get("sub"):
        return reply(403, message="Administrator sign-in required.")
    method = request.get("http", {}).get("method")
    try:
        table = os.environ["TABLE_NAME"]
        if method == "GET":
            if identifier := (event.get("queryStringParameters") or {}).get("match"):
                return find_supporters(table, identifier)
            return review(event, table)
        if method == "PATCH":
            return change_listing(event, table)
        return reply(405, message="Method not allowed.")
    except ValueError:
        return reply(400, message="Invalid registration reference or listing change.")
    except ClientError as error:
        code = error.response.get("Error", {}).get("Code")
        if code == "ConditionalCheckFailedException":
            return reply(404, message="Registration not found.")
        logger.warning("Listing administration failed: code=%s", code)
        return reply(503, message="Listing administration is temporarily unavailable.")
