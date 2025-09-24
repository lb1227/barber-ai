let BASE = null;

async function init() {
  // read server config (served by your Render app)
  // if you prefer hardcode, set BASE = "https://barber-ai.onrender.com"
  const cfg = await fetch("https://barber-ai.onrender.com/config").then(r => r.json()).catch(() => null);
  BASE = (cfg && cfg.baseUrl) || "https://barber-ai.onrender.com";

  document.getElementById("btnConnect").onclick = () => {
    window.location.href = `${BASE}/auth/google`;
  };

  document.getElementById("btnMe").onclick = async () => {
    const me = await fetch(`${BASE}/gcal/me`, { credentials: "omit" }).then(r => r.json()).catch(e => ({error: e+""}));
    document.getElementById("me").textContent = JSON.stringify(me, null, 2);
  };

  document.getElementById("btnToday").onclick = async () => {
    const evs = await fetch(`${BASE}/gcal/today`).then(r => r.json()).catch(e => ({error: e+""}));
    document.getElementById("events").textContent = JSON.stringify(evs, null, 2);
  };

  document.getElementById("btnCheckDate").onclick = async () => {
    const d = document.getElementById("date").value;
    if (!d) return;
    // reuse your quick endpoint style: create one if you like (/gcal/list?date=YYYY-MM-DD)
    const evs = await fetch(`${BASE}/gcal/create?summary=Peek&start=${d}T00:00:00-04:00&end=${d}T00:10:00-04:00`, { method: "HEAD" })
      .then(() => ({ note: "Replace this with a proper /gcal/list endpoint." }))
      .catch(e => ({ error: e+"" }));
    document.getElementById("dayEvents").textContent = JSON.stringify(evs, null, 2);
  };

  document.getElementById("bookForm").onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    // your server books via tool — add a tiny HTTP helper if you want:
    // Quickly use /gcal/create route (works for testing)
    const start = f.get("start_iso");
    const dur   = parseInt(f.get("duration_min") || "30", 10);
    const endISO = new Date(new Date(start).getTime() + dur*60000).toISOString();
    const q = new URLSearchParams({
      summary: `${f.get("service")} — ${f.get("customer_name")}`,
      start: start,
      end: endISO
    });
    const res = await fetch(`${BASE}/gcal/create?${q.toString()}`).then(r => r.json()).catch(e => ({error: e+""}));
    document.getElementById("bookResult").textContent = JSON.stringify(res, null, 2);
  };
}

init();
