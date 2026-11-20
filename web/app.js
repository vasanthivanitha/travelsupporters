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
const editor = document.querySelector("#editor");
const tripResults = document.querySelector("#tripResults");
const tripRows = document.querySelector("#tripRows");
const dateFormat = new Intl.DateTimeFormat("en-US", {dateStyle: "medium"});
const count = document.querySelector("#count");
const formStatus = document.querySelector("#formStatus");
const registrationStatus = document.querySelector("#registrationStatus");
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
fetch("airports.json").then(response => {
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
function openForm(selectedRole) {
  role = selectedRole;
  form.reset();
  form.elements.shareLanguage.disabled = true;
  formStatus.textContent = "";
  form.elements.date.min = localDate(new Date());
  form.querySelectorAll("input[list]").forEach(updateAirport);
  const offering = role === "offer";
  document.querySelector("#formTitle").textContent = offering ? "Offer help on your trip" : "Request a travel companion";
  document.querySelector("#tripForLabel").hidden = offering;
  document.querySelector("#scopeLabel").hidden = !offering;
  document.querySelector("#elderLabel").hidden = !offering;
  document.querySelector("#paymentLabel").hidden = !offering;
  document.querySelector("#travelerDetails").textContent = offering ? "How you can help" : "Languages and preferences";
  document.querySelector("#supportLegend").textContent = offering ? "What can you help with?" : "What would you like help with?";
  document.querySelector("#notesLabel").textContent = offering ? "Anything else the traveler should know? (optional)" : "Anything else your companion should know? (optional)";
  form.elements.help.placeholder = offering ? "e.g. I can meet you near the check-in counter" : "e.g. I’d like someone to walk with me to the connecting gate";
  editor.showModal();
}
document.querySelectorAll("[data-role]").forEach(button => button.addEventListener("click", () => openForm(button.dataset.role)));
document.querySelector(".close").addEventListener("click", () => editor.close());
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
  const fields = new FormData(form);
  const details = Object.fromEntries(fields);
  const { from, to, name, email, date, language, flight, help, connection, flex, traveler, scope } = details;
  const support = fields.getAll("support");
  if (!name.trim() || !language.trim() || (!help.trim() && !support.length)) {
    formStatus.textContent = "Enter a full name and language, then choose a type of help or add a short note.";
    return;
  }
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
  const submit = form.querySelector('[type="submit"]');
  if (submit.disabled) return;
  const payload = JSON.stringify(trip);
  if (pendingRegistration?.payload !== payload) {
    pendingRegistration = {payload, id: crypto.randomUUID()};
  }
  submit.disabled = true;
  const close = form.querySelector(".close");
  close.disabled = true;
  formStatus.textContent = "Submitting your registration…";
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({...trip, id: pendingRegistration.id}),
      signal: AbortSignal.timeout(15000),
    });
    const result = await response.json();
    if (!response.ok || result.id !== pendingRegistration.id) {
      formStatus.textContent = result.message || "Registration could not be confirmed. Please try again.";
      return;
    }
    pendingRegistration = null;
    editor.close();
    registrationStatus.hidden = false;
    registrationStatus.textContent = "Registration received. Save your reference number: " + result.id;
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
    submit.disabled = false;
    close.disabled = false;
  }
});
editor.addEventListener("cancel", event => {
  if (form.querySelector('[type="submit"]').disabled) event.preventDefault();
});
loadTrips();
