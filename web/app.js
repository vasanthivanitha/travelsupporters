const supportTypes = {
  checkin: "Check-in and departure gate",
  connection: "Getting through a connection",
  language: "Language assistance",
  baggage: "Finding baggage claim",
  arrival: "Finding the arrival pickup area",
  company: "Company during the journey"
};
const filters = document.querySelector("#filters");
const form = document.querySelector("#tripForm");
const registration = document.querySelector("#registration");
const cancelRegistration = document.querySelector("#cancelRegistration");
const registrationButtons = [...document.querySelectorAll("button[data-role]")];
let registrationTrigger;
const tripResults = document.querySelector("#tripResults");
const tripRows = document.querySelector("#tripRows");
const dateFormat = new Intl.DateTimeFormat("en-US", {dateStyle: "medium"});
const count = document.querySelector("#count");
const formStatus = document.querySelector("#formStatus");
const registrationStatus = document.querySelector("#registrationStatus");
const registrationSteps = [...form.querySelectorAll(".registration-step")];
const progressItems = [...form.querySelectorAll(".registration-progress li")];
const previousStep = document.querySelector("#previousStep");
const continueStep = document.querySelector("#continueStep");
let activeStep = 0;
let pendingRegistration;
let role;

function localDate(date) {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}
const endpoint = document.querySelector('meta[name="registration-endpoint"]')?.content || "/api/registrations";
const retryTrips = document.querySelector("#retryTrips");
const tripSearch = document.querySelector("#tripSearch");
const tripSort = document.querySelector("#tripSort");
const collator = new Intl.Collator("en", {sensitivity: "base"});
let airportData = {};
let loadedTrips = [];
let boardLoaded = false;
let search = new URLSearchParams();
let boardRequest = 0;

for (const [value, label] of Object.entries(supportTypes)) {
  filters.elements.support.add(new Option(label, value));
  const choice = document.createElement("label");
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.name = "support";
  checkbox.value = value;
  choice.append(checkbox, label);
  document.querySelector("#supportChoices").append(choice);
}

const airportInputs = [...document.querySelectorAll("input[list]")];
function updateAirport(input) {
  input.value = input.value.toUpperCase();
  const code = input.value;
  const airport = airportData[code];
  const inputIsInIndia = input.form === form
    ? (input.name === "from") === (form.elements.direction.value === "outbound")
    : null;
  const wrongCountry = airport && inputIsInIndia !== null && (airport[1] === "IN") !== inputIsInIndia;
  input.setCustomValidity(wrongCountry ? "Choose an airport that matches the travel direction." : "");
  const hint = document.getElementById(input.getAttribute("aria-describedby"));
  hint.textContent = code.length === 3
    ? airport?.[0] || "Airport name unavailable. Check the code before continuing."
    : "";
  const suggestions = [];
  if (/^[A-Z]{1,3}$/.test(code)) {
    for (const [iata, [name, country]] of Object.entries(airportData)) {
      if (!iata.startsWith(code) || (inputIsInIndia !== null && (country === "IN") !== inputIsInIndia)) continue;
      suggestions.push(new Option(name, iata));
      if (suggestions.length === 20) break;
    }
  }
  input.list.replaceChildren(...suggestions);
}
for (const input of airportInputs) {
  input.addEventListener("input", () => updateAirport(input));
}
form.elements.direction.addEventListener("change", () => {
  form.querySelectorAll("input[list]").forEach(updateAirport);
});
const airportDirectory = fetch("airports.json").then(response => {
  if (!response.ok) throw new Error("Airport directory unavailable");
  return response.json();
}).then(data => {
  airportData = data;
  airportInputs.forEach(updateAirport);
  render();
}).catch(() => {
  airportInputs.forEach(updateAirport);
});

function airport(code) {
  return airportData[code] ? airportData[code][0] + " (" + code + ")" : code;
}
function append(parent, tag, value, className) {
  const element = document.createElement(tag);
  element.textContent = value;
  if (className) element.className = className;
  parent.append(element);
  return element;
}
function tripCell(row, label) {
  const cell = row.insertCell();
  cell.setAttribute("role", "cell");
  append(cell, "span", label, "trip-cell-label").setAttribute("aria-hidden", "true");
  return cell;
}
const publicShare = document.querySelector("#publicShare");
const shareDestination = document.querySelector("#publicDestination");
const shareDraft = document.querySelector("#publicDraft");
const shareLink = document.querySelector("#openPublicDestination");
const publicShareHint = document.querySelector("#publicShareHint");
const publicShareStatus = document.querySelector("#publicShareStatus");
let shareOfferUrl;
let shareTrigger;
let communityDestinations = [];
let communityLoad;

function updateShareDestination() {
  const group = communityDestinations.find(item => item.id === shareDestination.value);
  if (group) {
    shareLink.href = group.url;
    shareLink.textContent = group.kind === "facebook" ? "Open Facebook group" : "Open community website";
    publicShareHint.textContent = "Copy the post, then open " + group.name + " and paste it into its posting form.";
    return;
  }
  shareLink.href = "https://www.facebook.com/sharer/sharer.php?u=" + encodeURIComponent(shareOfferUrl);
  shareLink.textContent = "Open Facebook share";
  publicShareHint.textContent = "Facebook opens a composer with the trip link. Choose the group in Facebook and publish when ready.";
}

async function loadDestinations() {
  const url = new URL("/api/communities", new URL(endpoint, location.origin));
  const response = await fetch(url, {signal: AbortSignal.timeout(10000)});
  if (!response.ok) throw new Error("The community directory could not be loaded.");
  const result = await response.json();
  communityDestinations = result.communities.filter(group => {
    try { return new URL(group.url).protocol === "https:"; } catch { return false; }
  });
  for (const group of communityDestinations) {
    const type = group.kind === "facebook" ? "Facebook" : "Website";
    shareDestination.add(new Option(group.name + " · " + type, group.id));
  }
}

function openPublicShare(trip, trigger) {
  shareTrigger = trigger;
  const offer = new URL("/", location.origin);
  offer.search = new URLSearchParams({offer: "1", from: trip.from, to: trip.to, date: trip.date});
  shareOfferUrl = offer.href;
  shareDraft.value = "Travel companion wanted | " + airport(trip.from) + " to " + airport(trip.to) +
    " | " + travelDate(trip) + "\n\nAlready flying this route? Offer support through Travel Supports:\n" + shareOfferUrl;
  shareDestination.value = "facebook";
  publicShareStatus.textContent = "";
  publicShare.hidden = false;
  updateShareDestination();
  document.querySelector("#publicShareTitle").focus();
  if (!communityLoad) {
    communityLoad = loadDestinations().catch(() => {
      communityLoad = null;
      publicShareStatus.textContent = "Saved community destinations are temporarily unavailable. Facebook sharing is still available.";
    });
  }
}

shareDestination.addEventListener("change", updateShareDestination);
document.querySelector("#copyPublicPost").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(shareDraft.value);
    publicShareStatus.textContent = "Post copied.";
  } catch {
    shareDraft.focus();
    shareDraft.select();
    publicShareStatus.textContent = "Copy the selected post to share it.";
  }
});
document.querySelector("#closePublicShare").addEventListener("click", () => {
  publicShare.hidden = true;
  if (shareTrigger?.isConnected) shareTrigger.focus();
  else tripSearch.focus();
});

function tripType(trip) {
  return trip.role === "offer" ? "Supporter offer" : "Companion request";
}
function travelDate(trip) {
  return dateFormat.format(new Date(trip.date + "T12:00:00"));
}
function render() {
  const terms = tripSearch.value.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  const rows = loadedTrips.filter(trip => {
    if (!terms.length) return true;
    const searchable = [trip.date, travelDate(trip), airport(trip.from), airport(trip.to), tripType(trip), trip.language]
      .join(" ").toLocaleLowerCase();
    return terms.every(term => searchable.includes(term));
  });
  const sort = tripSort.value;
  const sortValues = {
    soonest: trip => trip.date,
    latest: trip => trip.date,
    from: trip => airport(trip.from),
    to: trip => airport(trip.to),
    language: trip => trip.language || "",
    role: tripType
  };
  rows.sort((first, second) => {
    const key = sortValues[sort];
    const a = key(first);
    const b = key(second);
    if (sort === "language" && Boolean(a) !== Boolean(b)) return a ? -1 : 1;
    return (sort === "latest" ? -1 : 1) * collator.compare(a, b) || collator.compare(first.date, second.date);
  });
  tripRows.replaceChildren();
  tripResults.hidden = rows.length === 0;
  for (const trip of rows) {
    const row = tripRows.insertRow();
    row.setAttribute("role", "row");
    const date = append(tripCell(row, "Travel date"), "time", travelDate(trip));
    date.dateTime = trip.date;
    append(tripCell(row, "From"), "span", airport(trip.from));
    append(tripCell(row, "To"), "span", airport(trip.to));
    append(tripCell(row, "Trip type"), "span", tripType(trip), "badge");
    append(tripCell(row, "Languages spoken"), "span", trip.language || "Not shared");
    const shareCell = tripCell(row, "Share");
    if (trip.role === "request") {
      const share = append(shareCell, "button", "Share request", "outline");
      share.type = "button";
      share.addEventListener("click", () => openPublicShare(trip, share));
    } else {
      append(shareCell, "span", "—");
    }
  }
  if (boardLoaded) {
    count.textContent = rows.length
      ? rows.length + (rows.length === 1 ? " upcoming trip shown." : " upcoming trips shown.")
      : "No trips match your search.";
  }
}
async function loadTrips() {
  const request = ++boardRequest;
  loadedTrips = [];
  boardLoaded = false;
  render();
  count.textContent = "Loading upcoming trips…";
  retryTrips.hidden = true;
  const url = new URL(endpoint, location.origin);
  url.search = search;
  try {
    const results = [];
    let after;
    do {
      if (after) url.searchParams.set("after", after);
      const response = await fetch(url, {signal: AbortSignal.timeout(12000)});
      if (!response.ok) throw new Error("Trip board unavailable");
      const result = await response.json();
      if (request !== boardRequest) return;
      if (result.after && result.after === after) throw new Error("Trip board pagination did not advance");
      results.push(...result.trips);
      after = result.after;
    } while (after);
    loadedTrips = results;
    boardLoaded = true;
    render();
  } catch {
    if (request !== boardRequest) return;
    count.textContent = "The trip board could not be loaded.";
    retryTrips.hidden = false;
  }
}
function showRegistrationStep(index) {
  activeStep = index;
  for (const [position, step] of registrationSteps.entries()) {
    step.hidden = position !== index;
    const item = progressItems[position];
    if (position === index) item.setAttribute("aria-current", "step");
    else item.removeAttribute("aria-current");
    item.classList.toggle("complete", position < index);
  }
  previousStep.hidden = index === 0;
  const isReview = index === registrationSteps.length - 1;
  continueStep.textContent = isReview ? (role === "offer" ? "Send support offer" : "Send companion request") : "Continue";
  formStatus.textContent = "";
  if (isReview) {
    const { from, to, date, email } = form.elements;
    document.querySelector("#reviewRoute").textContent = airport(from.value) + " to " + airport(to.value);
    document.querySelector("#reviewDate").textContent = travelDate({date: date.value});
    document.querySelector("#reviewEmail").textContent = email.value;
  }
  registrationSteps[index].querySelector("h3").focus({preventScroll: true});
  registration.scrollIntoView({block: "start"});
}

function validateRegistrationStep(index) {
  const step = registrationSteps[index];
  const controls = [...step.querySelectorAll("input, select, textarea")];
  const invalid = controls.find(control => control.willValidate && !control.validity.valid);
  if (invalid) {
    showRegistrationStep(index);
    const details = invalid.closest("details");
    if (details) details.open = true;
    invalid.reportValidity();
    return false;
  }
  if (index === 1 && !form.elements.name.value.trim()) {
    showRegistrationStep(index);
    formStatus.textContent = "Enter your full name.";
    form.elements.name.focus();
    return false;
  }
  if (index === 2 && (!form.elements.language.value.trim() ||
      (!form.elements.help.value.trim() && !form.querySelector('input[name="support"]:checked')))) {
    showRegistrationStep(index);
    formStatus.textContent = "Enter a language, then choose a type of help or add a short note.";
    return false;
  }
  return true;
}

function showRegistration(visible) {
  registration.hidden = !visible;
  for (const button of registrationButtons) {
    button.setAttribute("aria-expanded", String(visible && button.dataset.role === role));
  }
}

function openForm(button) {
  if (continueStep.disabled) return;
  registrationTrigger = button;
  if (!registration.hidden && role === button.dataset.role) {
    showRegistrationStep(activeStep);
    return;
  }
  role = button.dataset.role;
  form.reset();
  form.elements.shareLanguage.disabled = true;
  formStatus.textContent = "";
  form.elements.date.min = localDate(new Date());
  form.querySelectorAll("input[list]").forEach(updateAirport);
  const offering = role === "offer";
  registration.dataset.role = role;
  document.querySelector("#formTitle").textContent = offering ? "Offer help on your trip" : "Request a travel companion";
  document.querySelector("#tripForLabel").hidden = offering;
  document.querySelector("#scopeLabel").hidden = !offering;
  document.querySelector("#elderLabel").hidden = !offering;
  document.querySelector("#paymentLabel").hidden = !offering;
  document.querySelector("#preferencesHeading").textContent = offering ? "What support can you offer?" : "What would make the trip easier?";
  document.querySelector("#supportLegend").textContent = offering ? "What can you help with?" : "What would you like help with?";
  document.querySelector("#notesLabel").textContent = offering ? "Anything else the traveler should know? (optional)" : "Anything else your companion should know? (optional)";
  form.elements.help.placeholder = offering ? "e.g. I can meet you near the check-in counter" : "e.g. I’d like someone to walk with me to the connecting gate";
  form.querySelector(".itinerary").open = false;
  showRegistration(true);
  showRegistrationStep(0);
}
registrationButtons.forEach(button => button.addEventListener("click", () => openForm(button)));
cancelRegistration.addEventListener("click", () => {
  showRegistration(false);
  registrationTrigger.focus();
});
previousStep.addEventListener("click", () => showRegistrationStep(activeStep - 1));
filters.addEventListener("submit", event => {
  event.preventDefault();
  search = new URLSearchParams([...new FormData(filters)].filter(([, value]) => value));
  loadTrips();
});
retryTrips.addEventListener("click", loadTrips);
tripSearch.addEventListener("input", render);
tripSort.addEventListener("change", render);
form.elements.publish.addEventListener("change", () => {
  form.elements.shareLanguage.disabled = !form.elements.publish.checked;
  if (!form.elements.publish.checked) form.elements.shareLanguage.checked = false;
});
form.addEventListener("submit", async event => {
  event.preventDefault();
  if (continueStep.disabled || !validateRegistrationStep(activeStep)) return;
  if (activeStep < registrationSteps.length - 1) {
    showRegistrationStep(activeStep + 1);
    return;
  }
  if (!registrationSteps.every((_, index) => validateRegistrationStep(index))) return;
  const fields = new FormData(form);
  const details = Object.fromEntries(fields);
  const { from, to, name, email, date, language, flight, help, connection, flex, traveler, scope } = details;
  const support = fields.getAll("support");
  const trip = {
    role, date, support, email: email.trim(), publish: fields.has("publish"), shareLanguage: fields.has("shareLanguage"),
    connection: connection.toUpperCase(), flex: Number(flex),
    traveler: role === "request" ? traveler : "", scope: role === "offer" ? scope : "",
    from: from.toUpperCase(), to: to.toUpperCase(),
    name: name.trim(), language: language.trim(), flight: flight.trim().toUpperCase(), help: help.trim()
  };
  for (const key of ["phoneAbroad", "phoneIndia", "direction", "airline", "fromCity", "toCity",
    "departureTime", "connectingFlight1", "connectingFlight2"]) {
    trip[key] = details[key].trim();
  }
  if (role === "offer") {
    trip.elder = details.elder;
    trip.payment = details.payment;
  }
  if (location.protocol !== "https:") {
    formStatus.textContent = "Open the HTTPS website before submitting a registration.";
    return;
  }
  const payload = JSON.stringify(trip);
  if (pendingRegistration?.payload !== payload) {
    const token = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
      .replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
    pendingRegistration = {payload, id: crypto.randomUUID(), token};
  }
  continueStep.disabled = true;
  previousStep.disabled = true;
  cancelRegistration.disabled = true;
  formStatus.textContent = "Submitting your registration…";
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({...trip, id: pendingRegistration.id, manageToken: pendingRegistration.token}),
      signal: AbortSignal.timeout(15000),
    });
    const result = await response.json();
    if (!response.ok || result.id !== pendingRegistration.id) {
      formStatus.textContent = result.message || "Registration could not be confirmed. Please try again.";
      return;
    }
    const privateLink = new URL("/trip.html", location.origin);
    privateLink.hash = new URLSearchParams({view: "manage", id: result.id, token: pendingRegistration.token});
    pendingRegistration = null;
    showRegistration(false);
    registrationStatus.hidden = false;
    registrationStatus.textContent = "Registration received. Save your reference number: " + result.id;
    const link = append(registrationStatus, "a", " Manage this trip");
    link.href = privateLink.href;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    append(registrationStatus, "span", " — save this private link to edit or withdraw your trip.");
    registrationStatus.focus();
    if (trip.publish) {
      search = new URLSearchParams();
      filters.reset();
      tripSearch.value = "";
      filters.querySelectorAll("input[list]").forEach(updateAirport);
      loadTrips();
    }
  } catch {
    formStatus.textContent = "Registration could not be confirmed. Please try again.";
  } finally {
    continueStep.disabled = false;
    previousStep.disabled = false;
    cancelRegistration.disabled = false;
  }
});
const sharedOffer = new URLSearchParams(location.search);
if (sharedOffer.get("offer") === "1") {
  airportDirectory.then(() => {
    if (!registration.hidden) return;
    const button = registrationButtons.find(button => button.dataset.role === "offer");
    openForm(button);
    const from = sharedOffer.get("from") || "";
    const to = sharedOffer.get("to") || "";
    if (airportData[from]?.[1] !== "IN" && airportData[to]?.[1] === "IN") {
      form.elements.direction.value = "inbound";
    }
    for (const [name, value] of [["from", from], ["to", to]]) {
      if (/^[A-Z]{3}$/.test(value)) form.elements[name].value = value;
      updateAirport(form.elements[name]);
    }
    const date = sharedOffer.get("date") || "";
    if (/^\d{4}-\d{2}-\d{2}$/.test(date) && date >= form.elements.date.min) form.elements.date.value = date;
  });
}
loadTrips();
