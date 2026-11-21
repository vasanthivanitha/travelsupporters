const params = new URLSearchParams(location.hash.slice(1));
const credentials = Object.fromEntries(["view", "id", "token"].map(key => [key, params.get(key)]));
const message = document.querySelector("#tripMessage");
const details = document.querySelector("#tripDetails");
const manageForm = document.querySelector("#manageTrip");
const invitation = document.querySelector("#invitation");
const meetingForm = document.querySelector("#meetingForm");
const controls = [...details.querySelectorAll("button")];
let endpoint = "/api/trip";
let busy = false;

function show(result) {
  if (result.route) document.querySelector("#tripRoute").textContent = result.route;
  const state = document.querySelector("#tripState");
  state.textContent = result.status + (result.date ? " · Departure " + result.date : "");
  if (result.supporterDate && result.supporterDate !== result.date) state.textContent += " · Supporter departs " + result.supporterDate;
  const isInvite = credentials.view === "invite";
  invitation.hidden = !isInvite;
  manageForm.hidden = isInvite || result.status === "Closed";
  details.hidden = false;
  if (!isInvite) {
    if (result.date) manageForm.elements.date.value = result.date;
    if (result.flight !== undefined) manageForm.elements.flight.value = result.flight;
    return;
  }
  for (const button of invitation.querySelectorAll("[data-action]")) {
    button.hidden = result.status === "Declined" || button.dataset.action === result.ownResponse ||
      (button.dataset.action === "accept" && result.ownResponse === "accepted");
  }
  const contact = document.querySelector("#matchedContact");
  contact.textContent = result.contact ? "Your match’s email: " + result.contact : "";
  meetingForm.hidden = !result.confirmed;
  meetingForm.elements.meeting.value = result.meeting || "";
  document.querySelector("#reconfirmState").textContent =
    (result.reconfirmed ? "You reconfirmed." : "Your reconfirmation is pending.") + " " +
    (result.otherReconfirmed ? "Your match also reconfirmed." : "Your match has yet to reconfirm.");
}

async function request(action, extra = {}) {
  if (busy) return;
  busy = true;
  controls.forEach(button => { button.disabled = true; });
  message.textContent = "Working…";
  try {
    const response = await fetch(endpoint, {
      method: "POST", headers: {"Content-Type": "application/json"},
      body: JSON.stringify({...credentials, action, ...extra}),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message);
    show(result);
    message.textContent = action === "view" ? "" : "Trip updated.";
  } catch (error) {
    message.textContent = error.message || "This action could not be completed.";
  } finally {
    busy = false;
    controls.forEach(button => { button.disabled = false; });
  }
}

manageForm.addEventListener("submit", event => {
  event.preventDefault();
  request("save", {date: manageForm.elements.date.value, flight: manageForm.elements.flight.value.trim().toUpperCase()});
});
meetingForm.addEventListener("submit", event => {
  event.preventDefault();
  request("reconfirm", {meeting: meetingForm.elements.meeting.value.trim()});
});
for (const control of details.querySelectorAll("[data-action]")) {
  control.addEventListener("click", () => {
    const action = control.dataset.action;
    if (action === "withdraw" && !confirm("Withdraw this trip and remove it from the public board?")) return;
    request(action);
  });
}

async function initialize() {
  if (!["manage", "invite"].includes(credentials.view) || !credentials.id || !credentials.token) {
    message.textContent = "Open the private link provided for your trip.";
    return;
  }
  if (!location.hostname.endsWith(".cloudfront.net")) {
    try {
      const response = await fetch("admin-config.json");
      if (response.ok) endpoint = new URL("/api/trip", (await response.json()).api).href;
    } catch {
      // The same-origin route is available on the managed distribution.
    }
  }
  document.querySelector("#tripTitle").textContent = credentials.view === "invite" ? "Your match invitation" : "Manage your trip";
  request("view");
}
initialize();
