import json
import os
import re
from hashlib import sha256
from urllib.parse import urlsplit, urlunsplit

from botocore.exceptions import ClientError

from registrations import dynamodb, field, reply


def community_url(raw_url, kind):
    if not raw_url or any(char.isspace() or ord(char) < 32 for char in raw_url) or "\\" in raw_url:
        raise ValueError("Enter a valid HTTPS community link.")
    url = urlsplit(raw_url)
    if url.scheme != "https" or not url.hostname or url.username or url.password:
        raise ValueError("Enter a valid HTTPS community link.")
    if kind == "facebook":
        if url.hostname not in {"facebook.com", "www.facebook.com", "m.facebook.com"} or not re.fullmatch(
            r"/groups/[A-Za-z0-9._-]+/?", url.path
        ):
            raise ValueError("Enter the direct link to a Facebook group, such as https://www.facebook.com/groups/group-name.")
        return urlunsplit(("https", "www.facebook.com", url.path.rstrip("/"), "", ""))
    return raw_url


def list_communities(table):
    groups = []
    scan = {"TableName": table, "ConsistentRead": True}
    while True:
        page = dynamodb.scan(**scan)
        for item in page.get("Items", []):
            groups.append({key: item[key]["S"] for key in ("id", "name", "kind", "url")})
        if not page.get("LastEvaluatedKey"):
            break
        scan["ExclusiveStartKey"] = page["LastEvaluatedKey"]
    return reply(200, communities=sorted(groups, key=lambda group: group["name"].casefold()))


def handler(event, context):
    table = os.environ["COMMUNITIES_TABLE"]
    request = event.get("requestContext", {})
    method = request.get("http", {}).get("method")
    if method == "GET":
        try:
            return list_communities(table)
        except ClientError:
            return reply(503, message="The community directory is temporarily unavailable.")
    claims = request.get("authorizer", {}).get("jwt", {}).get("claims", {})
    if method != "POST" or claims.get("token_use") != "access" or not claims.get("sub"):
        return reply(403, message="Administrator sign-in required.")
    try:
        body = event.get("body") or ""
        if len(body) > 4096 or event.get("isBase64Encoded"):
            raise ValueError("Invalid community request.")
        data = json.loads(body)
        if not isinstance(data, dict):
            raise ValueError("Invalid community request.")
        if data.get("action") == "remove":
            identifier = field(data, "id", 64, r"[a-f0-9]{64}", True)
            dynamodb.delete_item(TableName=table, Key={"id": {"S": identifier}})
            return reply(200, removed=True)
        if data.get("action") != "add":
            raise ValueError("Choose add or remove.")
        name = field(data, "name", 80, required=True)
        kind = field(data, "kind", 8, r"facebook|website", True)
        url = community_url(field(data, "url", 500, required=True), kind)
        identifier = sha256(url.encode()).hexdigest()
        group = {"id": identifier, "name": name, "kind": kind, "url": url}
        dynamodb.put_item(TableName=table, Item={key: {"S": value} for key, value in group.items()},
                          ConditionExpression="attribute_not_exists(id)")
        return reply(201, community=group)
    except ValueError as error:
        return reply(400, message=str(error))
    except ClientError as error:
        if error.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException":
            return reply(409, message="That link is already in the directory.")
        return reply(503, message="The community directory is temporarily unavailable.")
