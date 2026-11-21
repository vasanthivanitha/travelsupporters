import hashlib
import json
import logging
import os
import re
import secrets
from datetime import date, datetime, timedelta, timezone
from urllib.parse import urlencode
from uuid import UUID

import boto3
from botocore.exceptions import ClientError

from registrations import dynamodb, field, reply

logger = logging.getLogger(__name__)


def digest(token):
    return hashlib.sha256(token.encode()).hexdigest()


def token_matches(expected, token):
    return bool(expected and isinstance(token, str) and len(token) <= 128 and
                secrets.compare_digest(expected, digest(token)))


def today():
    return datetime.now(timezone.utc).date()


def value(item, key, default=""):
    return item.get(key, {}).get("S", default)


def get_trip(identifier):
    if not isinstance(identifier, str) or len(identifier) != 36 or str(UUID(identifier)) != identifier:
        raise ValueError("Invalid trip reference.")
    return dynamodb.get_item(
        TableName=os.environ["TABLE_NAME"], Key={"id": {"S": identifier}}, ConsistentRead=True,
    ).get("Item", {})


def state_of(item):
    return json.loads(value(item, "coordination", "{}"))


def closed(item):
    return item.get("withdrawn", {}).get("BOOL") is True or state_of(item).get("closed", False)


def public_status(item, state):
    if state.get("closed") or closed(item):
        return "Closed"
    primary = state.get("primary")
    if not primary or "declined" in (primary["traveler"], primary["supporter"]):
        return "Open"
    return "Confirmed" if both_accepted(primary) else "Invited"


def both_accepted(slot):
    return slot["traveler"] == slot["supporter"] == "accepted"


def update(item, assignments, remove=()):
    names = {"#id": "id", "#rev": "tripRevision"}
    values = {":next": {"S": secrets.token_hex(12)}}
    sets = ["#rev = :next"]
    for index, (key, data) in enumerate(assignments.items()):
        names[f"#a{index}"] = key
        values[f":a{index}"] = data
        sets.append(f"#a{index} = :a{index}")
    remove_keys = []
    for index, key in enumerate(remove):
        names[f"#d{index}"] = key
        remove_keys.append(f"#d{index}")
    condition = "attribute_exists(#id) AND attribute_not_exists(#rev)"
    if revision := item.get("tripRevision"):
        condition = "attribute_exists(#id) AND #rev = :previous"
        values[":previous"] = revision
    dynamodb.update_item(
        TableName=os.environ["TABLE_NAME"], Key={"id": item["id"]},
        ConditionExpression=condition,
        UpdateExpression="SET " + ", ".join(sets) + (" REMOVE " + ", ".join(remove_keys) if remove_keys else ""),
        ExpressionAttributeNames=names, ExpressionAttributeValues=values,
    )


def save_coordination(trip, state):
    primary = state.get("primary")
    update(trip, {"coordination": {"S": json.dumps(state)},
                  "matchConfirmed": {"BOOL": bool(primary and both_accepted(primary) and not state.get("closed"))}})


def link(page, identifier, token, origin=None):
    base = origin or os.environ.get("SITE_ORIGIN", "https://travelsupporters.com")
    return base + "/trip.html#" + urlencode({"view": page, "id": identifier, "token": token})


def send_email(recipient, subject, message):
    sender = os.environ.get("EMAIL_SENDER", "")
    if not sender or not recipient:
        return False
    try:
        boto3.client("ses").send_email(
            Source=sender, Destination={"ToAddresses": [recipient]},
            Message={"Subject": {"Data": subject}, "Body": {"Text": {"Data": message}}},
        )
        return True
    except ClientError as error:
        logger.warning("Coordination email failed: code=%s", error.response.get("Error", {}).get("Code"))
        return False


def snapshot(item):
    return [value(item, key) for key in ("date", "from", "to", "flight", "connection", "connectingFlight1", "connectingFlight2")]


def slot_is_current(traveler, slot, supporter):
    return (supporter and not closed(supporter) and snapshot(traveler) == slot["travelerTrip"]
            and snapshot(supporter) == slot["supporterTrip"])


def route_compatible(request, offer):
    if snapshot(request)[1:3] != snapshot(offer)[1:3]:
        return False
    request_date, offer_date = (date.fromisoformat(value(item, "date")) for item in (request, offer))
    flex = sum(min(3, max(0, int(item.get("flex", {}).get("N", "0")))) for item in (request, offer))
    return min(request_date, offer_date) >= today() and abs((request_date - offer_date).days) <= flex


def admin_action(data):
    trip = get_trip(data.get("id"))
    if not trip:
        return reply(404, message="Trip not found.")
    action = data.get("action")
    origin = data.get("origin") or os.environ.get("SITE_ORIGIN", "https://travelsupporters.com")
    cloudfront = os.environ.get("CLOUDFRONT_ORIGIN")
    if origin not in {"https://travelsupporters.com", cloudfront}:
        raise ValueError("Invalid website address.")
    identifier = value(trip, "id")
    state = state_of(trip)
    if action == "status":
        result = {}
        for key in ("primary", "backup"):
            slot = state.get(key)
            if slot:
                supporter = get_trip(slot["offer"])
                result[key] = {**{field: slot[field] for field in ("offer", "traveler", "supporter")},
                               "current": bool(slot_is_current(trip, slot, supporter)),
                               "feedback": slot.get("feedback", {})}
        return reply(200, status=public_status(trip, state), slots=result)
    if action == "manageLink":
        token = secrets.token_urlsafe(32)
        update(trip, {"manageHash": {"S": digest(token)}})
        url = link("manage", identifier, token, origin)
        return reply(200, links=[{"label": "Trip owner", "email": value(trip, "email"), "url": url,
                                "sent": send_email(value(trip, "email"), "Manage your Travel Supports trip", url)}])
    if value(trip, "role") != "request" or closed(trip):
        return reply(409, message="This request is closed.")
    if action == "close":
        state["closed"] = True
        update(trip, {"coordination": {"S": json.dumps(state)}, "withdrawn": {"BOOL": True}}, ("listing",))
        return reply(200, status="Closed")
    if action == "cancelPrimary":
        state.pop("primary", None)
        save_coordination(trip, state)
        return reply(200, status="Open")
    if action == "promote":
        backup = state.get("backup")
        if not backup or "declined" in (backup["traveler"], backup["supporter"]):
            return reply(409, message="There is no willing backup supporter to promote.")
        supporter = get_trip(backup["offer"])
        if not slot_is_current(trip, backup, supporter):
            return reply(409, message="The backup itinerary has changed. Invite again.")
        state["primary"] = state.pop("backup")
        save_coordination(trip, state)
        return reply(200, status=public_status(trip, state))
    if action != "invite" or data.get("slot") not in ("primary", "backup"):
        raise ValueError("Invalid coordination action.")
    slot_key = data["slot"]
    offer = get_trip(data.get("offer"))
    if not offer or value(offer, "role") != "offer" or closed(offer) or not route_compatible(trip, offer):
        return reply(409, message="This supporter no longer matches the route and date.")
    other = state.get("backup" if slot_key == "primary" else "primary")
    if other and other["offer"] == value(offer, "id"):
        return reply(409, message="This supporter is already in the other slot.")
    tokens = {party: secrets.token_urlsafe(32) for party in ("traveler", "supporter")}
    state[slot_key] = {
        "offer": value(offer, "id"), "traveler": "pending", "supporter": "pending",
        "tokens": {party: digest(token) for party, token in tokens.items()},
        "travelerTrip": snapshot(trip), "supporterTrip": snapshot(offer), "origin": origin,
    }
    save_coordination(trip, state)
    links = []
    for party, item in (("traveler", trip), ("supporter", offer)):
        url = link("invite", identifier, tokens[party], origin)
        email = value(item, "email")
        sent = send_email(email, "Travel Supports match invitation",
                          "Review and respond to your private match invitation:\n" + url)
        links.append({"label": party.title(), "email": email, "url": url, "sent": sent})
    return reply(200, status=public_status(trip, state), links=links)


def manage(data, trip):
    if not token_matches(value(trip, "manageHash"), data.get("token")):
        return reply(404, message="This private link is invalid or has been replaced.")
    state = state_of(trip)
    action = data.get("action", "view")
    if action in ("save", "withdraw"):
        if closed(trip):
            return reply(409, message="This trip has been closed.")
        if action == "withdraw":
            state["closed"] = True
            update(trip, {"withdrawn": {"BOOL": True}, "coordination": {"S": json.dumps(state)}}, ("listing",))
            return reply(200, status="Closed")
        if public_status(trip, state) in ("Invited", "Confirmed"):
            return reply(409, message="Ask the administrator to close or update the active match before changing your itinerary.")
        departure = field(data, "date", 10, r"\d{4}-\d{2}-\d{2}", True)
        if date.fromisoformat(departure) < today():
            raise ValueError("Choose an upcoming departure date.")
        flight = field(data, "flight", 15, r"[A-Z0-9 -]+")
        update(trip, {"date": {"S": departure}}, ("flight",)) if not flight else update(trip, {"date": {"S": departure}, "flight": {"S": flight}})
        return reply(200, status="Saved")
    if action != "view":
        raise ValueError("Invalid trip action.")
    return reply(200, status=public_status(trip, state), route=" to ".join(snapshot(trip)[1:3]),
                 date=value(trip, "date"), flight=value(trip, "flight"))


def respond(data, trip):
    state = state_of(trip)
    if closed(trip):
        return reply(404, message="This invitation is closed.")
    for key in ("primary", "backup"):
        slot = state.get(key)
        if not slot:
            continue
        for party, expected in slot["tokens"].items():
            if token_matches(expected, data.get("token")) or token_matches(slot.get("reminderTokens", {}).get(party), data.get("token")) or token_matches(slot.get("feedbackTokens", {}).get(party), data.get("token")):
                return respond_to_slot(data, trip, state, slot, key, party)
    return reply(404, message="This invitation is invalid or has been replaced.")


def respond_to_slot(data, trip, state, slot, key, party):
    offer = get_trip(slot["offer"])
    if not slot_is_current(trip, slot, offer):
        return reply(409, message="The itinerary changed. Contact the Travel Supports administrator.")
    action = data.get("action", "view")
    confirmed = key == "primary" and both_accepted(slot)
    last_departure = max(date.fromisoformat(value(item, "date")) for item in (trip, offer))
    days_since_trip = (today() - last_departure).days
    if confirmed and 1 <= days_since_trip <= 30:
        if action == "feedback":
            connected = field(data, "connected", 3, r"yes|no", True)
            helpful = field(data, "helpful", 3, r"yes|no", required=connected == "yes")
            slot.setdefault("feedback", {})[party] = {"connected": connected, "helpful": helpful if connected == "yes" else ""}
            save_coordination(trip, state)
        elif action != "view":
            return reply(409, message="Use the after-trip check-in for this completed match.")
        return reply(200, status="Trip completed", checkIn=True, submitted=party in slot.get("feedback", {}),
                     route=" to ".join(snapshot(trip)[1:3]), date=value(trip, "date"))
    if not route_compatible(trip, offer):
        return reply(409, message="The itinerary changed or the trip has passed. Contact the Travel Supports administrator.")
    if action in ("accept", "decline"):
        if slot[party] == "declined":
            return reply(409, message="You already declined. Ask the administrator for a new invitation.")
        slot[party] = "accepted" if action == "accept" else "declined"
        save_coordination(trip, state)
        confirmed = key == "primary" and both_accepted(slot)
    elif action == "reconfirm" and confirmed:
        slot[party + "Reconfirmed"] = True
        meeting = field(data, "meeting", 180)
        if meeting:
            slot["meeting"] = meeting
        save_coordination(trip, state)
    elif action != "view":
        raise ValueError("Invalid invitation action.")
    other_party = "supporter" if party == "traveler" else "traveler"
    return reply(
        200, status="Confirmed" if confirmed else "Backup accepted" if both_accepted(slot) else
        "Declined" if "declined" in (slot["traveler"], slot["supporter"]) else "Invited",
        ownResponse=slot[party], confirmed=confirmed, backup=key == "backup",
        route=" to ".join(snapshot(trip)[1:3]), date=value(trip, "date"), supporterDate=value(offer, "date"),
        contact=value(offer if party == "traveler" else trip, "email") if confirmed else "",
        reconfirmed=bool(slot.get(party + "Reconfirmed")),
        otherReconfirmed=bool(slot.get(other_party + "Reconfirmed")), meeting=slot.get("meeting", "") if confirmed else "",
    )


def handler(event, context):
    if event.get("source") == "aws.events":
        return scheduled_notifications()
    try:
        body = event.get("body") or ""
        if event.get("isBase64Encoded") or len(body) > 4096:
            raise ValueError("Request is too large.")
        data = json.loads(body)
        if not isinstance(data, dict):
            raise ValueError("Invalid request.")
        path = event.get("requestContext", {}).get("http", {}).get("path", "")
        if path.endswith("/admin/coordination"):
            claims = event.get("requestContext", {}).get("authorizer", {}).get("jwt", {}).get("claims", {})
            if claims.get("token_use") != "access" or not claims.get("sub"):
                return reply(403, message="Administrator sign-in required.")
            return admin_action(data)
        trip = get_trip(data.get("id"))
        if not trip:
            return reply(404, message="This private link is invalid.")
        if data.get("view") == "manage":
            return manage(data, trip)
        if data.get("view") == "invite":
            return respond(data, trip)
        raise ValueError("Invalid private link.")
    except ValueError as error:
        return reply(400, message=str(error))
    except ClientError as error:
        code = error.response.get("Error", {}).get("Code")
        if code == "ConditionalCheckFailedException":
            return reply(409, message="The trip changed while you were working. Reload and try again.")
        logger.warning("Trip coordination failed: code=%s", code)
        return reply(503, message="Trip coordination is temporarily unavailable.")


def all_trips():
    scan = {"TableName": os.environ["TABLE_NAME"]}
    while True:
        page = dynamodb.scan(**scan)
        yield from page.get("Items", [])
        if not page.get("LastEvaluatedKey"):
            break
        scan["ExclusiveStartKey"] = page["LastEvaluatedKey"]


def scheduled_notifications():
    if not os.environ.get("EMAIL_SENDER"):
        return {"status": "Email delivery is disabled"}
    items = {value(item, "id"): item for item in all_trips()}
    upcoming = [item for item in items.values() if not closed(item) and value(item, "date") >= today().isoformat()]
    requests = [item for item in upcoming if value(item, "role") == "request"]
    open_requests = [item for item in requests if public_status(item, state_of(item)) in ("Open", "Invited")]
    offers = [item for item in upcoming if value(item, "role") == "offer" and "matchAlerted" not in item]
    admin_email = os.environ.get("ALERT_EMAIL", "")
    if admin_email:
        alerts = []
        for offer in offers:
            matched = [request for request in open_requests if route_compatible(request, offer)]
            if matched:
                alerts.append((offer, matched))
        if alerts:
            lines = []
            for offer, matched in alerts[:25]:
                lines.append("Offer " + value(offer, "id") + " on " + " to ".join(snapshot(offer)[1:3]) +
                             " (" + value(offer, "date") + ") matches " +
                             ", ".join(value(request, "id") for request in matched[:10]))
            admin_page = os.environ.get("SITE_ORIGIN", "https://travelsupporters.com") + "/admin.html"
            if send_email(admin_email, "New Travel Supports matches", "\n".join(lines) + "\n\nReview: " + admin_page):
                for offer, _ in alerts[:25]:
                    try:
                        update(offer, {"matchAlerted": {"BOOL": True}})
                    except ClientError as error:
                        logger.warning("Could not mark match alert: code=%s", error.response.get("Error", {}).get("Code"))
    for request in requests:
        send_reminders(request, items)
    for request in items.values():
        if value(request, "role") == "request" and not closed(request):
            send_check_ins(request, items)
    if os.environ.get("ENGAGEMENT_TABLE"):
        from engagement import send_route_alerts
        send_route_alerts(open_requests)
    return {"status": "Notifications checked"}


def send_check_ins(request, items):
    state = state_of(request)
    slot = state.get("primary")
    if not slot or not both_accepted(slot):
        return
    offer = items.get(slot["offer"], {})
    if not slot_is_current(request, slot, offer):
        return
    last_departure = max(date.fromisoformat(value(item, "date")) for item in (request, offer))
    if not 1 <= (today() - last_departure).days <= 30:
        return
    deliver_match_emails(request, offer, state, "checkIns", "feedbackTokens",
                         "How did your Travel Supports trip go?",
                         "Tell us privately whether you connected and whether the support helped.")


def send_reminders(request, items):
    state = state_of(request)
    slot = state.get("primary")
    if not slot or not both_accepted(slot):
        return
    offer = items.get(slot["offer"], {})
    if not slot_is_current(request, slot, offer):
        return
    first_departure = min(date.fromisoformat(value(item, "date")) for item in (request, offer))
    if not 0 <= (first_departure - today()).days <= 2:
        return
    deliver_match_emails(request, offer, state, "reminders", "reminderTokens",
                         "Reconfirm your upcoming Travel Supports trip",
                         "Please check your itinerary and agree on a public meeting point.")


def deliver_match_emails(request, offer, state, delivery_key, token_key, subject, message):
    slot = state["primary"]
    delivery = slot.setdefault(delivery_key, {})
    tokens = slot.setdefault(token_key, {})
    pending = [(party, item) for party, item in (("traveler", request), ("supporter", offer)) if not delivery.get(party)]
    if not pending:
        return
    new_tokens = {party: secrets.token_urlsafe(32) for party, _ in pending}
    tokens.update({party: digest(token) for party, token in new_tokens.items()})
    try:
        save_coordination(request, state)
    except ClientError:
        return
    for party, item in pending:
        url = link("invite", value(request, "id"), new_tokens[party], slot.get("origin"))
        if send_email(value(item, "email"), subject, message + "\n" + url):
            delivery[party] = True
    refreshed = get_trip(value(request, "id"))
    current = state_of(refreshed)
    if current.get("primary", {}).get(token_key) != tokens:
        return
    current["primary"].setdefault(delivery_key, {}).update(delivery)
    try:
        save_coordination(refreshed, current)
    except ClientError:
        logger.warning("Could not mark match emails as delivered")
