const status = document.querySelector("#adminStatus");
const signIn = document.querySelector("#signIn");
const signOut = document.querySelector("#signOut");
const review = document.querySelector("#review");
const cards = document.querySelector("#adminCards");
const nextPage = document.querySelector("#nextPage");
const callback = location.origin + location.pathname;
const transactionKey = "travel-supports-admin-login";
let config;
let adminEndpoint;
let accessToken;
let after;

const outreach = document.querySelector("#outreach");
const matchStatus = document.querySelector("#matchStatus");
const matchResults = document.querySelector("#matchResults");
const shareDraft = document.querySelector("#shareDraft");
const sharePermission = document.querySelector("#sharePermission");
const shareStatus = document.querySelector("#shareStatus");
const copyPost = document.querySelector("#copyPost");
const copyPrompt = document.querySelector("#copyPrompt");
const whatsApp = document.querySelector("#shareWhatsApp");
const facebook = document.querySelector("#shareFacebook");
const communityForm = document.querySelector("#communityForm");
const communityList = document.querySelector("#communityLinks");
const communityStatus = document.querySelector("#communityStatus");
const communityKey = "travel-supports-community-links";
const helpLabels = {
  checkin: "check-in and finding the gate",
  connection: "getting through a connection",
  language: "language assistance",
  baggage: "finding baggage claim",
  arrival: "finding the pickup area",
  company: "company during the journey",
};
const coordinationStatus = document.querySelector("#coordinationStatus");
const coordinationActions = document.querySelector("#coordinationActions");
const invitationLinks = document.querySelector("#invitationLinks");
const draftLanguage = document.querySelector("#draftLanguage");
const translations = {
  hi: ["यात्रा साथी की तलाश", "इस मार्ग पर यात्रा कर रहे हैं? Travel Supports पर सहायता की पेशकश करें और अपनी उड़ान की जानकारी दें। कृपया सार्वजनिक टिप्पणियों में निजी जानकारी न लिखें।"],
  te: ["ప్రయాణ సహచరుడు కావాలి", "ఈ మార్గంలో ప్రయాణిస్తున్నారా? Travel Supports ద్వారా సహాయం అందించడానికి నమోదు చేసి, మీ విమాన వివరాలను తెలియజేయండి. వ్యక్తిగత వివరాలను బహిరంగ వ్యాఖ్యల్లో పెట్టవద్దు."],
  ta: ["பயணத் துணை தேவை", "இந்த வழித்தடத்தில் பயணம் செய்கிறீர்களா? Travel Supports தளத்தில் உதவி வழங்கப் பதிவு செய்து உங்கள் விமான விவரங்களைச் சேர்க்கவும். தனிப்பட்ட தகவல்களைப் பொதுக் கருத்துகளில் பகிர வேண்டாம்."],
};
let requestedHelp = [];
let selectedRequest;
let offerLink;
let suggestedPost;
let communities = [];
try {
  communities = JSON.parse(localStorage.getItem(communityKey) || "[]");
  if (!Array.isArray(communities)) communities = [];
} catch {
  communities = [];
}

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
  selectedRequest = null;
  offerLink = null;
  suggestedPost = "";
  shareDraft.value = "";
  sharePermission.checked = false;
  matchResults.replaceChildren();
  outreach.hidden = true;
  invitationLinks.replaceChildren();
  coordinationActions.replaceChildren();
  status.textContent = message;
  review.hidden = true;
  signOut.hidden = true;
  signIn.hidden = !adminEndpoint;
}

async function adminRequest(url, options = {}) {
  const headers = {Authorization: "Bearer " + accessToken};
  if (options.body) headers["Content-Type"] = "application/json";
  const response = await fetch(url, {...options, headers});
  if (response.status === 401 || response.status === 403) {
    showSignedOut("Your administrator session ended. Sign in again.");
    return null;
  }
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    throw new Error(result.message || "The admin API could not complete this action. Try again.");
  }
  return response.json();
}

function add(parent, tag, text, className) {
  const element = document.createElement(tag);
  element.textContent = text;
  if (className) element.className = className;
  parent.append(element);
  return element;
}

const directoryForm = document.querySelector("#directoryForm");
const directoryStatus = document.querySelector("#directoryStatus");
const directoryList = document.querySelector("#directoryList");

function directoryUrl(write = false) {
  const url = new URL(adminEndpoint, location.origin);
  url.pathname = write ? "/api/admin/communities" : "/api/communities";
  return url;
}

async function changeDirectory(data) {
  const result = await adminRequest(directoryUrl(true), {method: "POST", body: JSON.stringify(data)});
  if (result) await loadDirectory();
  return result;
}

async function loadDirectory() {
  directoryStatus.textContent = "Loading public destinations…";
  try {
    const response = await fetch(directoryUrl());
    if (!response.ok) throw new Error("The public community directory could not be loaded.");
    const result = await response.json();
    if (!adminEndpoint || !accessToken) return;
    directoryList.replaceChildren();
    for (const group of result.communities) {
      const row = add(directoryList, "li", "");
      const link = add(row, "a", group.name);
      link.href = group.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      add(row, "span", group.kind === "facebook" ? " · Facebook group" : " · Community website");
      coordinationButton(row, "Remove", async () => {
        try {
          await changeDirectory({action: "remove", id: group.id});
        } catch (error) {
          directoryStatus.textContent = error.message;
        }
      });
    }
    directoryStatus.textContent = result.communities.length ? "" : "No public destinations added yet.";
  } catch (error) {
    directoryStatus.textContent = error.message;
  }
}

directoryForm.addEventListener("submit", async event => {
  event.preventDefault();
  const button = directoryForm.querySelector("button");
  const fields = Object.fromEntries(new FormData(directoryForm));
  button.disabled = true;
  try {
    if (await changeDirectory({action: "add", ...fields})) directoryForm.reset();
  } catch (error) {
    directoryStatus.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

function safeCommunityUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

function renderCommunities() {
  communityList.replaceChildren();
  for (const [index, group] of communities.entries()) {
    const url = safeCommunityUrl(group?.url);
    if (!url || typeof group.name !== "string") continue;
    const row = add(communityList, "li", "");
    const link = add(row, "a", group.name);
    if (sharePermission.checked) link.href = url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    if (!sharePermission.checked) link.setAttribute("aria-disabled", "true");
    const remove = add(row, "button", "Remove", "outline");
    remove.type = "button";
    remove.setAttribute("aria-label", "Remove " + group.name);
    remove.addEventListener("click", () => saveCommunities(communities.filter((_, position) => position !== index)));
  }
}

function saveCommunities(next) {
  try {
    localStorage.setItem(communityKey, JSON.stringify(next));
    communities = next;
    communityStatus.textContent = "Community links saved in this browser.";
    renderCommunities();
    return true;
  } catch {
    communityStatus.textContent = "This browser could not save the community links.";
    return false;
  }
}

function updateSharing() {
  const enabled = sharePermission.checked && Boolean(offerLink);
  copyPost.disabled = !enabled || !shareDraft.value.trim();
  copyPrompt.disabled = !enabled;
  whatsApp.hidden = !enabled || !shareDraft.value.trim();
  facebook.hidden = !enabled;
  if (enabled) {
    whatsApp.href = "https://wa.me/?text=" + encodeURIComponent(shareDraft.value);
    facebook.href = "https://www.facebook.com/sharer/sharer.php?u=" + encodeURIComponent(offerLink);
  } else {
    whatsApp.removeAttribute("href");
    facebook.removeAttribute("href");
  }
  renderCommunities();
}

function createPost(request, help = [], language = draftLanguage.value) {
  if (translations[language]) {
    const [title, text] = translations[language];
    return [title + " | " + request.from + " → " + request.to + " | " + request.date, text, offerLink].join("\n\n");
  }
  const need = help.map(key => helpLabels[key]).filter(Boolean);
  return [
    "Travel companion wanted | " + request.from + " to " + request.to + " | " + request.date,
    "A traveler is looking for a companion on this route." + (need.length ? " Help requested: " + need.join(", ") + "." : ""),
    "Already traveling this route around that date? Offer support through Travel Supports and include your flight details so the team can check the itinerary.",
    offerLink,
    "Please keep contact and booking details out of public comments."
  ].join("\n\n");
}

function privateLinkRows(target, links) {
  target.replaceChildren();
  for (const entry of links) {
    const item = add(target, "li", "");
    add(item, "span", entry.label + (entry.sent ? " · email sent · " : " · email not sent · "));
    const copy = add(item, "button", "Copy private link", "outline");
    copy.type = "button";
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(entry.url);
        copy.textContent = "Copied";
      } catch {
        copy.textContent = "Use the open link to copy its address";
      }
    });
    const link = add(item, "a", "Open private link");
    link.href = entry.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    if (!entry.sent && entry.email) {
      const mail = add(item, "a", "Open email draft");
      mail.href = "mailto:" + encodeURIComponent(entry.email).replace("%40", "@") +
        "?subject=" + encodeURIComponent("Your private Travel Supports link") +
        "&body=" + encodeURIComponent("Use this private link:\n" + entry.url);
    }
  }
}

async function coordinate(request, action, extra = {}) {
  const endpoint = new URL(adminEndpoint, location.origin);
  endpoint.pathname = "/api/admin/coordination";
  return adminRequest(endpoint, {
    method: "POST", body: JSON.stringify({id: request.id, origin: location.origin, action, ...extra}),
  });
}

function coordinationButton(parent, label, handler) {
  const button = add(parent, "button", label, "outline");
  button.type = "button";
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      await handler();
    } catch (error) {
      if (!outreach.hidden) coordinationStatus.textContent = error.message;
      else status.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });
  return button;
}

async function loadCoordination(request) {
  const result = await coordinate(request, "status");
  if (!result || selectedRequest !== request) return;
  const summaries = Object.entries(result.slots).map(([key, slot]) =>
    (key === "primary" ? "Primary" : "Backup") + " " + slot.offer + " · traveler " + slot.traveler +
    ", supporter " + slot.supporter + (slot.current ? "" : " · itinerary changed"));
  coordinationStatus.textContent = "Request status: " + result.status + (summaries.length ? " · " + summaries.join(" · ") : "");
  coordinationActions.replaceChildren();
  coordinationButton(coordinationActions, "Refresh match status", () => loadCoordination(request));
  if (result.status === "Closed") return;
  if (result.slots.primary) {
    coordinationButton(coordinationActions, "Cancel primary match", async () => {
      if (!confirm("Cancel the primary match and invalidate its private invitations?")) return;
      if (await coordinate(request, "cancelPrimary")) await loadCoordination(request);
    });
  }
  if (result.slots.backup) {
    coordinationButton(coordinationActions, "Promote backup", async () => {
      if (!confirm("Replace the primary match with this backup supporter?")) return;
      if (await coordinate(request, "promote")) await loadCoordination(request);
    });
  }
  coordinationButton(coordinationActions, "Close request", async () => {
    if (!confirm("Close the request and remove it from the public board?")) return;
    if (await coordinate(request, "close")) {
      invitationLinks.replaceChildren();
      await loadCoordination(request);
    }
  });
}

function showMatch(match, request) {
  const row = add(matchResults, "li", "");
  add(row, "strong", match.sameFlight ? "Same first flight" : "Possible route match");
  add(row, "p", "Departure " + match.date + " · Reference " + match.id);
  if (match.connectionDiffers) add(row, "p", "Connection details differ.");
  if (match.helpInCommon.length) add(row, "p", "Help in common: " + match.helpInCommon.map(key => helpLabels[key]).join(", "));
  if (match.languagesInCommon.length) add(row, "p", "Languages in common: " + match.languagesInCommon.join(", "));
  if (match.email) {
    const contact = add(row, "a", "Email supporter");
    const subject = "Travel Supports companion request";
    const body = "Thanks for offering support. Are you available to help a traveler on " + request.from +
      " to " + request.to + " around " + request.date + "? Please confirm your flight and connections.";
    contact.href = "mailto:" + encodeURIComponent(match.email).replace("%40", "@") +
      "?subject=" + encodeURIComponent(subject) + "&body=" + encodeURIComponent(body);
  }
  for (const [slot, label] of [["primary", "Invite as primary"], ["backup", "Invite as backup"]]) {
    coordinationButton(row, label, async () => {
      if (!confirm("Create private invitations for both people? This replaces any existing invitation in that slot.")) return;
      const result = await coordinate(request, "invite", {offer: match.id, slot});
      if (!result || selectedRequest !== request) return;
      privateLinkRows(invitationLinks, result.links);
      await loadCoordination(request);
    });
  }
}

async function findAndShare(request) {
  selectedRequest = request;
  requestedHelp = [];
  draftLanguage.value = "en";
  invitationLinks.replaceChildren();
  coordinationActions.replaceChildren();
  coordinationStatus.textContent = "Loading request status…";
  const url = new URL("/", location.origin);
  url.search = new URLSearchParams({offer: "1", from: request.from, to: request.to, date: request.date});
  offerLink = url.href;
  suggestedPost = createPost(request);
  shareDraft.value = suggestedPost;
  sharePermission.checked = false;
  shareStatus.textContent = "";
  document.querySelector("#outreachRoute").textContent = request.from + " to " + request.to + " · " + request.date;
  matchResults.replaceChildren();
  matchStatus.textContent = "Checking registered supporter offers…";
  outreach.hidden = false;
  document.querySelector("#outreachTitle").focus();
  updateSharing();
  loadCoordination(request).catch(error => {
    if (selectedRequest === request) coordinationStatus.textContent = error.message;
  });
  try {
    const endpoint = new URL(adminEndpoint, location.origin);
    endpoint.searchParams.set("match", request.id);
    const result = await adminRequest(endpoint);
    if (!result || selectedRequest !== request) return;
    requestedHelp = result.requestedHelp;
    const post = createPost(request, requestedHelp);
    if (shareDraft.value === suggestedPost) shareDraft.value = post;
    suggestedPost = post;
    updateSharing();
    matchStatus.textContent = result.total
      ? "Showing " + result.matches.length + " of " + result.total + " matching offers. Confirm the full itinerary before connecting travelers."
      : "No registered offers match this route and travel window yet.";
    result.matches.forEach(match => showMatch(match, request));
  } catch (error) {
    if (selectedRequest === request) matchStatus.textContent = error.message;
  }
}

async function copySharingText(text) {
  if (!sharePermission.checked) return;
  try {
    await navigator.clipboard.writeText(text);
    shareStatus.textContent = "Copied.";
  } catch {
    shareStatus.textContent = "Clipboard unavailable. Select and copy the draft manually.";
    shareDraft.focus();
    shareDraft.select();
  }
}

sharePermission.addEventListener("change", updateSharing);
shareDraft.addEventListener("input", updateSharing);
draftLanguage.addEventListener("change", () => {
  if (!selectedRequest) return;
  suggestedPost = createPost(selectedRequest, requestedHelp);
  shareDraft.value = suggestedPost;
  updateSharing();
});
copyPost.addEventListener("click", () => copySharingText(shareDraft.value));
copyPrompt.addEventListener("click", () => copySharingText(
  "Rewrite this as a short post for a local Desi community group. Keep the route, date, and link. Do not add contact, booking, or personal details.\n\n" + suggestedPost
));
communityForm.addEventListener("submit", event => {
  event.preventDefault();
  const name = communityForm.elements.groupName.value.trim();
  const url = safeCommunityUrl(communityForm.elements.groupUrl.value.trim());
  if (!name || !url) {
    communityStatus.textContent = "Enter a group name and an HTTPS link.";
    return;
  }
  if (communities.some(group => group?.url === url)) {
    communityStatus.textContent = "This community link is already saved.";
    return;
  }
  if (saveCommunities([...communities, {name, url}])) communityForm.reset();
});

function showRegistration(registration) {
  const card = add(cards, "article", "", "card");
  add(card, "span", registration.role === "offer" ? "Supporter offer" : "Companion request", "badge");
  add(card, "h3", registration.from + " to " + registration.to);
  add(card, "p", registration.date);
  add(card, "p", "Reference " + registration.id);
  const state = add(card, "p", registration.published ? "Published" : "Private");
  if (registration.role === "request") {
    const outreachButton = add(card, "button", "Find and share", "outline");
    outreachButton.type = "button";
    outreachButton.addEventListener("click", () => findAndShare(registration));
  }
  const action = add(card, "button", registration.published ? "Unlist" : "Publish", "outline");
  action.type = "button";
  action.disabled = registration.withdrawn;
  const managementLinks = add(card, "ul", "");
  coordinationButton(card, "Create private trip link", async () => {
    if (!confirm("Create a new management link for the trip owner? Any previous management link will stop working.")) return;
    const result = await coordinate(registration, "manageLink");
    if (result) privateLinkRows(managementLinks, result.links);
  });
  action.addEventListener("click", async () => {
    const published = !registration.published;
    if (published && !window.confirm("Publish this trip’s route, date, and help categories? Confirm you have the traveler’s permission.")) return;
    action.disabled = true;
    try {
      const result = await adminRequest(adminEndpoint, {
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
    const url = new URL(adminEndpoint, location.origin);
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
  if (location.protocol !== "https:") {
    showSignedOut("Open the website over HTTPS to sign in.");
    return;
  }
  const response = await fetch("admin-config.json", {cache: "no-store"});
  if (!response.ok) throw new Error("The administrator sign-in configuration has not been deployed.");
  config = await response.json();
  if (location.origin === "https://travelsupporters.com") {
    adminEndpoint = config.api;
  } else if (config.cloudFrontOrigin && location.origin === config.cloudFrontOrigin) {
    adminEndpoint = "/api/admin/listings";
  } else {
    showSignedOut("This address is not registered for sign-in. Open https://travelsupporters.com/admin.html or use the CloudFront URL printed by the deploy script.");
    return;
  }
  if (!location.search) {
    showSignedOut("Sign in to review and edit listings.");
    return;
  }
  await finishLogin(new URLSearchParams(location.search));
  signOut.hidden = false;
  review.hidden = false;
  await Promise.all([loadPage(), loadDirectory()]);
}

initialize().catch(error => showSignedOut(error.message));
