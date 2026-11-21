const form = document.querySelector("#alertForm");
const manage = document.querySelector("#alertManage");
const status = document.querySelector("#alertStatus");
const params = new URLSearchParams(location.hash.slice(1));
const privateLink = params.has("id") && params.has("token");
const controls = [...document.querySelectorAll("button")];
let endpoint = "/api/alerts";
let busy = false;

async function send(payload) {
  if (busy) return;
  busy = true;
  controls.forEach(button => { button.disabled = true; });
  status.textContent = "Working…";
  try {
    const response = await fetch(endpoint, {
      method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(payload),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message);
    if (result.route) {
      manage.hidden = false;
      document.querySelector("#alertRoute").textContent = result.route;
      manage.querySelector('[data-alert-action="confirm"]').hidden = result.confirmed;
    }
    if (result.unsubscribed) manage.hidden = true;
    status.textContent = result.message || (result.confirmed ? "Your route alert is active." : "Confirm your subscription to start receiving alerts.");
  } catch (error) {
    status.textContent = error.message || "That action could not be completed.";
  } finally {
    busy = false;
    controls.forEach(button => { button.disabled = false; });
  }
}

const credentials = {id: params.get("id"), token: params.get("token")};
form.addEventListener("submit", event => {
  event.preventDefault();
  const fields = Object.fromEntries(new FormData(form));
  send({action: "subscribe", email: fields.email, from: fields.from.toUpperCase(), to: fields.to.toUpperCase()});
});
manage.querySelectorAll("[data-alert-action]").forEach(button => {
  button.addEventListener("click", () => send({...credentials, action: button.dataset.alertAction}));
});

async function initialize() {
  form.hidden = true;
  if (!location.hostname.endsWith(".cloudfront.net")) {
    try {
      const response = await fetch("admin-config.json");
      if (response.ok) endpoint = new URL("/api/alerts", (await response.json()).api).href;
    } catch {
      // The managed distribution exposes a same-origin endpoint.
    }
  }
  form.hidden = privateLink;
  if (privateLink) send({...credentials, action: "view"});
}
initialize();
