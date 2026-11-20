const airports = {
  from: { DEL: "Delhi", BOM: "Mumbai", BLR: "Bengaluru", HYD: "Hyderabad", MAA: "Chennai", AMD: "Ahmedabad", COK: "Kochi", CCU: "Kolkata", GOI: "Goa", PNQ: "Pune" },
  to: { JFK: "New York", EWR: "Newark", SFO: "San Francisco", ORD: "Chicago", IAD: "Washington, DC", LAX: "Los Angeles", SEA: "Seattle", DFW: "Dallas", ATL: "Atlanta", BOS: "Boston", IAH: "Houston", MIA: "Miami" }
};
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
const cards = document.querySelector("#cards");
const count = document.querySelector("#count");
const formStatus = document.querySelector("#formStatus");
const registrationStatus = document.querySelector("#registrationStatus");
let pendingRegistration;
let role;

function localDate(date) {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}
function futureDate(days) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return localDate(date);
}
const examples = [
  { role: "request", from: "DEL", to: "JFK", date: futureDate(18), name: "Meera", support: ["checkin", "baggage"], traveler: "A family member or friend", language: "Hindi or English", help: "Would like help finding the departure gate and baggage claim." },
  { role: "offer", from: "BOM", to: "EWR", date: futureDate(24), name: "Anika", support: ["checkin", "language"], scope: "Departure airport only", language: "Marathi or English", help: "Happy to walk with you through the airport and help you find your gate." },
  { role: "request", from: "BLR", to: "SFO", date: futureDate(29), name: "Lakshmi", support: ["connection", "company"], language: "Kannada or English", help: "Looking for a companion to help navigate a connecting airport." }
];

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

for (const [direction, options] of Object.entries(airports)) {
  for (const target of [filters, form]) {
    const select = target.elements[direction];
    select.add(new Option(target === filters ? "Any airport" : "Choose an airport", ""));
    for (const [code, city] of Object.entries(options)) {
      select.add(new Option(city + " (" + code + ")", code));
    }
    select.add(new Option("Other airport", "other"));
  }
}

for (const direction of ["from", "to"]) {
  const select = form.elements[direction];
  const custom = document.createElement("input");
  custom.name = direction + "Custom";
  custom.placeholder = "Enter airport code";
  custom.pattern = "[A-Za-z]{3}";
  custom.maxLength = 3;
  custom.setAttribute("aria-label", direction === "from" ? "Departure airport code" : "Arrival airport code");
  select.after(custom);
  select.addEventListener("change", () => {
    custom.hidden = select.value !== "other";
    custom.required = !custom.hidden;
  });
  select.dispatchEvent(new Event("change"));
}

function airport(direction, code) {
  return airports[direction][code] ? airports[direction][code] + " (" + code + ")" : code;
}
function append(parent, tag, value, className) {
  const element = document.createElement(tag);
  element.textContent = value;
  if (className) element.className = className;
  parent.append(element);
  return element;
}
function render() {
  const selected = Object.fromEntries(new FormData(filters));
  const shown = examples.filter(trip => {
    if (selected.support && !trip.support?.includes(selected.support)) return false;
    return ["from", "to", "role"].every(key => !selected[key] || selected[key] === trip[key] ||
      (selected[key] === "other" && !airports[key][trip[key]]));
  });
  cards.replaceChildren();
  count.textContent = shown.length ? shown.length + (shown.length === 1 ? " example trip" : " example trips") :
    "No example trips found. Try another filter.";
  for (const trip of shown) {
    const card = document.createElement("article");
    card.className = "card";
    append(card, "span", (trip.role === "offer" ? "Offering help" : "Looking for help") + " · Example trip", "badge");
    append(card, "h3", airport("from", trip.from) + " to " + airport("to", trip.to));
    const date = new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }).format(new Date(trip.date + "T12:00:00"));
    append(card, "p", date + (trip.flight ? " · " + trip.flight : ""));
    append(card, "p", trip.name + " · " + trip.language);
    if (trip.flex) append(card, "p", "Date flexible by " + trip.flex + (trip.flex === 1 ? " day" : " days"));
    if (trip.connection) append(card, "p", "Connection: " + trip.connection);
    if (trip.traveler) append(card, "p", "Request for: " + trip.traveler);
    if (trip.scope) append(card, "p", trip.scope);
    const types = (trip.support || []).map(type => supportTypes[type]).filter(Boolean);
    if (types.length) {
      const list = append(card, "ul", "", "support-tags");
      for (const type of types) append(list, "li", type);
    }
    if (trip.help) append(card, "p", trip.help);
    cards.append(card);
  }
}
function openForm(selectedRole) {
  role = selectedRole;
  form.reset();
  formStatus.textContent = "";
  form.elements.date.min = localDate(new Date());
  for (const direction of ["from", "to"]) form.elements[direction].dispatchEvent(new Event("change"));
  const offering = role === "offer";
  document.querySelector("#formTitle").textContent = offering ? "Offer help on your trip" : "Request a travel companion";
  document.querySelector("#tripForLabel").hidden = offering;
  document.querySelector("#scopeLabel").hidden = !offering;
  document.querySelector("#supportLegend").textContent = offering ? "What can you help with?" : "What would you like help with?";
  document.querySelector("#notesLabel").textContent = offering ? "Anything else the traveler should know? (optional)" : "Anything else your companion should know? (optional)";
  form.elements.help.placeholder = offering ? "e.g. I can meet you near the check-in counter" : "e.g. I’d like someone to walk with me to the connecting gate";
  editor.showModal();
}
document.querySelectorAll("[data-role]").forEach(button => button.addEventListener("click", () => openForm(button.dataset.role)));
document.querySelector(".close").addEventListener("click", () => editor.close());
filters.addEventListener("submit", event => {
  event.preventDefault();
  render();
});
form.addEventListener("submit", async event => {
  event.preventDefault();
  const fields = new FormData(form);
  const { from, to, fromCustom, toCustom, name, email, date, language, flight, help, connection, flex, traveler, scope } = Object.fromEntries(fields);
  const support = fields.getAll("support");
  if (!name.trim() || !language.trim() || (!help.trim() && !support.length)) {
    formStatus.textContent = "Enter a first name and language, then choose a type of help or add a short note.";
    return;
  }
  const trip = {
    role, date, support, email: email.trim(),
    connection: connection.toUpperCase(), flex: Number(flex),
    traveler: role === "request" ? traveler : "", scope: role === "offer" ? scope : "",
    from: from === "other" ? fromCustom.toUpperCase() : from,
    to: to === "other" ? toCustom.toUpperCase() : to,
    name: name.trim(), language: language.trim(), flight: flight.trim().toUpperCase(), help: help.trim()
  };
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
    const endpoint = document.querySelector('meta[name="registration-endpoint"]')?.content || "/api/registrations";
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
render();
