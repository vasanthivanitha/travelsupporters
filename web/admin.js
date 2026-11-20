const status = document.querySelector("#adminStatus");
const signIn = document.querySelector("#signIn");
const signOut = document.querySelector("#signOut");
const review = document.querySelector("#review");
const cards = document.querySelector("#adminCards");
const nextPage = document.querySelector("#nextPage");
const callback = location.origin + location.pathname;
const transactionKey = "travel-supports-admin-login";
let config;
let accessToken;
let after;

function base64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function beginLogin() {
  const state = base64url(crypto.getRandomValues(new Uint8Array(24)));
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const url = new URL("/oauth2/authorize", config.loginOrigin);
  url.search = new URLSearchParams({
    response_type: "code", client_id: config.clientId, redirect_uri: callback,
    scope: "openid", state, code_challenge_method: "S256",
    code_challenge: base64url(new Uint8Array(digest)),
  });
  sessionStorage.setItem(transactionKey, JSON.stringify({state, verifier}));
  location.assign(url);
}

async function finishLogin(params) {
  const transaction = JSON.parse(sessionStorage.getItem(transactionKey) || "null");
  sessionStorage.removeItem(transactionKey);
  history.replaceState(null, "", location.pathname);
  if (!transaction || !params.has("code") || transaction.state !== params.get("state")) {
    throw new Error("Sign-in could not be verified. Try signing in again.");
  }
  const response = await fetch(new URL("/oauth2/token", config.loginOrigin), {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "authorization_code", client_id: config.clientId, redirect_uri: callback,
      code: params.get("code"), code_verifier: transaction.verifier,
    }),
  });
  if (!response.ok) throw new Error("Sign-in failed. Try signing in again.");
  accessToken = (await response.json()).access_token;
  if (!accessToken) throw new Error("Sign-in did not return an access token.");
}

function showSignedOut(message) {
  accessToken = null;
  after = null;
  cards.replaceChildren();
  status.textContent = message;
  review.hidden = true;
  signOut.hidden = true;
  signIn.hidden = !config || location.origin !== "https://travelsupporters.com";
}

async function adminRequest(url, options = {}) {
  const headers = {Authorization: "Bearer " + accessToken};
  if (options.body) headers["Content-Type"] = "application/json";
  const response = await fetch(url, {...options, headers});
  if (response.status === 401 || response.status === 403) {
    showSignedOut("Your administrator session ended. Sign in again.");
    return null;
  }
  if (!response.ok) throw new Error("The admin API could not complete this action. Try again.");
  return response.json();
}

function add(parent, tag, text, className) {
  const element = document.createElement(tag);
  element.textContent = text;
  if (className) element.className = className;
  parent.append(element);
  return element;
}

function showRegistration(registration) {
  const card = add(cards, "article", "", "card");
  add(card, "span", registration.role === "offer" ? "Supporter offer" : "Companion request", "badge");
  add(card, "h3", registration.from + " to " + registration.to);
  add(card, "p", registration.date);
  add(card, "p", "Reference " + registration.id);
  const state = add(card, "p", registration.published ? "Published" : "Private");
  const action = add(card, "button", registration.published ? "Unlist" : "Publish", "outline");
  action.type = "button";
  action.addEventListener("click", async () => {
    const published = !registration.published;
    if (published && !window.confirm("Publish this trip’s route, date, and help categories? Confirm you have the traveler’s permission.")) return;
    action.disabled = true;
    try {
      const result = await adminRequest(config.api, {
        method: "PATCH", body: JSON.stringify({id: registration.id, published}),
      });
      if (!result) return;
      registration.published = result.published;
      state.textContent = result.published ? "Published" : "Private";
      action.textContent = result.published ? "Unlist" : "Publish";
      status.textContent = result.published ? "Listing published. The public board may take a moment to update." : "Listing made private. The public board may take a moment to update.";
    } catch (error) {
      status.textContent = error.message;
    } finally {
      action.disabled = false;
    }
  });
}

async function loadPage() {
  nextPage.disabled = true;
  status.textContent = "Loading registrations…";
  try {
    const url = new URL(config.api);
    if (after) url.searchParams.set("after", after);
    const result = await adminRequest(url);
    if (!result) return;
    result.registrations.forEach(showRegistration);
    after = result.after;
    status.textContent = cards.childElementCount ? "" : "No registrations found.";
    nextPage.hidden = !after;
    nextPage.textContent = "Load more registrations";
  } catch (error) {
    status.textContent = error.message;
    nextPage.textContent = "Retry";
    nextPage.hidden = false;
  } finally {
    nextPage.disabled = false;
  }
}

signIn.addEventListener("click", () => beginLogin().catch(() => showSignedOut("Could not start sign-in. Please try again.")));
signOut.addEventListener("click", () => {
  showSignedOut("Signed out.");
  const url = new URL("/logout", config.loginOrigin);
  url.search = new URLSearchParams({client_id: config.clientId, logout_uri: callback});
  location.assign(url);
});
nextPage.addEventListener("click", loadPage);

async function initialize() {
  if (location.origin !== "https://travelsupporters.com") {
    showSignedOut("Open https://travelsupporters.com/admin.html to sign in.");
    return;
  }
  const response = await fetch("admin-config.json", {cache: "no-store"});
  if (!response.ok) throw new Error("The administrator sign-in configuration has not been deployed.");
  config = await response.json();
  if (!location.search) {
    showSignedOut("Sign in to review and edit listings.");
    return;
  }
  await finishLogin(new URLSearchParams(location.search));
  signOut.hidden = false;
  review.hidden = false;
  await loadPage();
}

initialize().catch(error => showSignedOut(error.message));
