import json
import os
import secrets
from datetime import datetime, timedelta, timezone
from urllib.parse import urlencode
from uuid import UUID, uuid4

from botocore.exceptions import ClientError

from coordination import digest, send_email, token_matches, value
from registrations import dynamodb, field, reply

REASONS = {"Suspicious listing", "Inappropriate message", "Unexpected fee", "Other"}


def scan_kind(kind):
    query = {
        "TableName": os.environ["ENGAGEMENT_TABLE"],
        "FilterExpression": "#kind = :kind",
        "ExpressionAttributeNames": {"#kind": "kind"},
        "ExpressionAttributeValues": {":kind": {"S": kind}},
    }
    while True:
        page = dynamodb.scan(**query)
        yield from page.get("Items", [])
        if not page.get("LastEvaluatedKey"):
            break
        query["ExclusiveStartKey"] = page["LastEvaluatedKey"]


def site():
    return os.environ.get("SITE_ORIGIN", "https://travelsupporters.com")


def subscribe(data, table):
    if not os.environ.get("EMAIL_SENDER"):
        return reply(503, message="Route alert email is not configured yet.")
    email = field(data, "email", 254, r"[^\s@]+@[^\s@]+\.[^\s@]+", True).lower()
    departure = field(data, "from", 3, r"[A-Z]{3}")
    arrival = field(data, "to", 3, r"[A-Z]{3}")
    if not (departure or arrival) or (departure and departure == arrival):
        raise ValueError("Enter a departure or arrival airport. Use different airports for a route.")
    identifier = "alert-" + digest(email + "\n" + departure + "\n" + arrival)
    token = secrets.token_urlsafe(32)
    expires = int((datetime.now(timezone.utc) + timedelta(days=1)).timestamp())
    item = {key: {"S": entry} for key, entry in {
        "id": identifier, "kind": "alert", "email": email, "from": departure, "to": arrival, "tokenHash": digest(token)
    }.items() if entry}
    item["expiresAt"] = {"N": str(expires)}
    try:
        dynamodb.put_item(
            TableName=table, Item=item,
            ConditionExpression="attribute_not_exists(id) OR expiresAt < :now",
            ExpressionAttributeValues={":now": {"N": str(int(datetime.now(timezone.utc).timestamp()))}},
        )
    except ClientError as error:
        if error.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException":
            return reply(200, message="If this subscription is new, check your email for a confirmation link.")
        raise
    try:
        day = datetime.now(timezone.utc).date().isoformat()
        dynamodb.update_item(
            TableName=table, Key={"id": {"S": "alert-quota-" + digest(email + day)}},
            UpdateExpression="SET expiresAt = :expires ADD sentCount :one",
            ConditionExpression="attribute_not_exists(sentCount) OR sentCount < :limit",
            ExpressionAttributeValues={":expires": {"N": str(expires)}, ":one": {"N": "1"}, ":limit": {"N": "5"}},
        )
    except ClientError as error:
        dynamodb.delete_item(TableName=table, Key={"id": item["id"]},
                             ConditionExpression="tokenHash = :token",
                             ExpressionAttributeValues={":token": item["tokenHash"]})
        if error.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException":
            return reply(429, message="Too many confirmation requests today. Try again tomorrow.")
        raise
    url = site() + "/alerts.html#" + urlencode({"id": identifier, "token": token})
    if not send_email(email, "Confirm your Travel Supports route alert",
                      "Confirm your route alert using this private link within 24 hours:\n" + url):
        dynamodb.delete_item(TableName=table, Key={"id": item["id"]},
                             ConditionExpression="tokenHash = :token",
                             ExpressionAttributeValues={":token": item["tokenHash"]})
        return reply(503, message="The confirmation email could not be sent. Try again later.")
    return reply(200, message="If this subscription is new, check your email for a confirmation link.")


def alert_access(data, table):
    identifier = field(data, "id", 70, r"alert-[a-f0-9]{64}", True)
    key = {"id": {"S": identifier}}
    item = dynamodb.get_item(TableName=table, Key=key, ConsistentRead=True).get("Item", {})
    if not any(token_matches(value(item, key), data.get("token")) for key in ("tokenHash", "deliveryTokenHash")):
        return reply(404, message="This alert link is invalid or expired.")
    expires = item.get("expiresAt", {}).get("N")
    if expires and int(expires) <= int(datetime.now(timezone.utc).timestamp()):
        return reply(404, message="This alert link is invalid or expired.")
    action = data.get("action")
    args = {
        "TableName": table, "Key": key, "ConditionExpression": "tokenHash = :token",
        "ExpressionAttributeValues": {":token": item["tokenHash"]},
    }
    if action == "unsubscribe":
        dynamodb.delete_item(**args)
        return reply(200, message="You’re unsubscribed.", unsubscribed=True)
    if action == "confirm":
        args["ExpressionAttributeValues"][":yes"] = {"BOOL": True}
        dynamodb.update_item(**args, UpdateExpression="SET confirmed = :yes REMOVE expiresAt")
    return reply(200, confirmed=action == "confirm" or item.get("confirmed", {}).get("BOOL", False),
                 route=(value(item, "from") or "Any airport") + " to " + (value(item, "to") or "Any airport"))


def report(data, table):
    reference = field(data, "reference", 36, required=True)
    if str(UUID(reference)) != reference:
        raise ValueError("Invalid listing reference.")
    names = {f"#{key}": key for key in ("id", "listing", "from", "to", "date")}
    trip = dynamodb.get_item(
        TableName=os.environ["TABLE_NAME"], Key={"id": {"S": reference}}, ConsistentRead=True,
        ProjectionExpression=", ".join(names), ExpressionAttributeNames=names,
    ).get("Item", {})
    if value(trip, "listing") != "PUBLIC":
        return reply(404, message="This listing is no longer public.")
    reason = field(data, "reason", 30, required=True)
    if reason not in REASONS:
        raise ValueError("Choose a report reason.")
    note = field(data, "note", 400)
    fields = {"id": "report-" + str(uuid4()), "kind": "report", "reference": reference, "reason": reason,
              "route": value(trip, "from") + " to " + value(trip, "to"), "date": value(trip, "date"),
              "reportedAt": datetime.now(timezone.utc).isoformat(), "note": note}
    dynamodb.put_item(TableName=table, Item={key: {"S": entry} for key, entry in fields.items() if entry})
    return reply(201, message="Report sent to Travel Supports for review.")


def admin_reports(data, table):
    if data.get("action") == "review":
        identifier = field(data, "id", 43, r"report-[a-f0-9-]{36}", True)
        dynamodb.update_item(TableName=table, Key={"id": {"S": identifier}}, UpdateExpression="SET reviewed = :yes",
                             ConditionExpression="#kind = :report", ExpressionAttributeNames={"#kind": "kind"},
                             ExpressionAttributeValues={":yes": {"BOOL": True}, ":report": {"S": "report"}})
    elif data.get("action") != "list":
        raise ValueError("Invalid report action.")
    records = [{key: value(item, key) for key in ("id", "reference", "reason", "route", "date", "reportedAt", "note")}
               for item in scan_kind("report") if not item.get("reviewed", {}).get("BOOL")]
    return reply(200, reports=sorted(records, key=lambda row: row["reportedAt"], reverse=True))


def send_route_alerts(open_requests):
    table = os.environ["ENGAGEMENT_TABLE"]
    current = [trip for trip in open_requests if value(trip, "listing") == "PUBLIC"]
    for sub in scan_kind("alert"):
        if not sub.get("confirmed", {}).get("BOOL"):
            continue
        departure, arrival = value(sub, "from"), value(sub, "to")
        matching = [trip for trip in current if (not departure or departure == value(trip, "from"))
                    and (not arrival or arrival == value(trip, "to"))]
        seen = set(sub.get("seen", {}).get("SS", []))
        new = [trip for trip in matching if value(trip, "id") not in seen][:20]
        if not new:
            continue
        # Keep the original confirmation link valid when issuing an unsubscribe link.
        token = secrets.token_urlsafe(32)
        token_hash = {"S": digest(token)}
        args = {"TableName": table, "Key": {"id": sub["id"]}, "ConditionExpression": "tokenHash = :previous",
                "ExpressionAttributeValues": {":previous": sub["tokenHash"], ":next": token_hash}}
        try:
            dynamodb.update_item(**args, UpdateExpression="SET deliveryTokenHash = :next")
        except ClientError:
            continue
        manage_url = site() + "/alerts.html#" + urlencode({"id": value(sub, "id"), "token": token})
        lines = ["\n".join((value(trip, "from") + " to " + value(trip, "to") + " · " + value(trip, "date"),
                           site() + "/?" + urlencode({"offer": "1", "from": value(trip, "from"), "to": value(trip, "to"),
                                                      "date": value(trip, "date"), "request": value(trip, "id")}))) for trip in new]
        sent = send_email(value(sub, "email"), "Travel Supports route alert",
                          "\n\n".join(lines) + "\n\nManage or unsubscribe: " + manage_url)
        try:
            if sent:
                retained = seen & {value(trip, "id") for trip in matching}
                delivered = sorted(retained | {value(trip, "id") for trip in new})
                dynamodb.update_item(TableName=table, Key={"id": sub["id"]}, UpdateExpression="SET seen = :seen",
                                     ConditionExpression="deliveryTokenHash = :token", ExpressionAttributeValues={":token": token_hash, ":seen": {"SS": delivered}})
        except ClientError:
            continue


def handler(event, context):
    try:
        body = event.get("body") or ""
        if event.get("isBase64Encoded") or len(body) > 4096:
            raise ValueError("Invalid request.")
        data = json.loads(body)
        if not isinstance(data, dict):
            raise ValueError("Invalid request.")
        table = os.environ["ENGAGEMENT_TABLE"]
        request = event.get("requestContext", {})
        path = request.get("http", {}).get("path", "")
        if path.endswith("/admin/reports"):
            claims = request.get("authorizer", {}).get("jwt", {}).get("claims", {})
            if claims.get("token_use") != "access" or not claims.get("sub"):
                return reply(403, message="Administrator sign-in required.")
            return admin_reports(data, table)
        if path.endswith("/reports"):
            return report(data, table)
        action = data.get("action")
        if action == "subscribe":
            return subscribe(data, table)
        if action in ("view", "confirm", "unsubscribe"):
            return alert_access(data, table)
        raise ValueError("Invalid alert action.")
    except ValueError as error:
        return reply(400, message=str(error))
    except ClientError as error:
        if error.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException":
            return reply(409, message="This item has changed. Reload and try again.")
        return reply(503, message="This service is temporarily unavailable.")
