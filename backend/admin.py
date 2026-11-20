import json
import logging
import os
from uuid import UUID

from botocore.exceptions import ClientError

from registrations import dynamodb, reply

logger = logging.getLogger(__name__)


def registration_id(value):
    if not isinstance(value, str) or len(value) != 36 or str(UUID(value)) != value:
        raise ValueError("Enter a valid registration reference.")
    return value


def review(event, table):
    names = {f"#{key}": key for key in ("id", "role", "from", "to", "date", "listing")}
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
        }
        for record in result.get("Items", [])
    ]
    next_key = result.get("LastEvaluatedKey")
    return reply(200, registrations=items, after=next_key["id"]["S"] if next_key else None)


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
        "ConditionExpression": "attribute_exists(#id)",
        "ExpressionAttributeNames": {"#id": "id", "#listing": "listing"},
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
