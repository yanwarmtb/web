// /functions/api/getData.js
// GET /api/getData?kelas=kelas_1&tanggal=2025-09-11
// ENV: GITHUB_TOKEN (contents:read)

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const OWNER_REPO = "mrdickymiswardi/server";
const BRANCH = "main";

// Headers GitHub API
const ghHeaders = (token) => ({
  Authorization: `Bearer ${token}`,
  Accept: "application/vnd.github.v3+json",
  "User-Agent": "cf-pages-functions",
});

// base64 → UTF-8 aman
const dec = new TextDecoder();
const b64decode = (b64 = "") => {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return dec.decode(bytes);
};

export async function onRequest({ request, env }) {
  // CORS preflight
  if (request.method === "OPTIONS")
    return new Response(null, { status: 204, headers: CORS });

  if (request.method !== "GET")
    return new Response("Method Not Allowed", { status: 405, headers: CORS });

  if (!env.GITHUB_TOKEN) {
    return new Response(JSON.stringify({ error: "GITHUB_TOKEN belum diset di environment." }), {
      status: 500, headers: { "Content-Type": "application/json", ...CORS },
    });
  }

  const url = new URL(request.url);
  const tanggal = url.searchParams.get("tanggal");
  const kelas   = url.searchParams.get("kelas");

  if (!tanggal || !kelas) {
    return new Response(JSON.stringify({ error: "Parameter 'tanggal' dan 'kelas' wajib ada." }), {
      status: 400, headers: { "Content-Type": "application/json", ...CORS },
    });
  }

  const fileName = `${kelas}_${tanggal}.json`;
  const apiUrl =
    `https://api.github.com/repos/${OWNER_REPO}/contents/absensi/` +
    `${encodeURIComponent(fileName)}?ref=${encodeURIComponent(BRANCH)}`;

  try {
    const res = await fetch(apiUrl, { headers: ghHeaders(env.GITHUB_TOKEN) });

    if (res.status === 404) {
      // file belum ada → kembalikan []
      return new Response("[]", {
        status: 200, headers: { "Content-Type": "application/json", ...CORS },
      });
    }

    if (!res.ok) {
      const t = await res.text().catch(() => "");
      return new Response(
        JSON.stringify({
          error: `Gagal ambil file absensi (${res.status})`,
          detail: t.slice(0, 300),
        }),
        { status: res.status, headers: { "Content-Type": "application/json", ...CORS } }
      );
    }

    const json = await res.json(); // { content: "base64", ... }
    let data = [];
    try {
      const content = b64decode(json.content || "");
      data = JSON.parse(content || "[]");
    } catch {
      data = [];
    }

    return new Response(JSON.stringify(data), {
      status: 200, headers: { "Content-Type": "application/json", ...CORS },
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: String(err?.message || err) }), {
      status: 500, headers: { "Content-Type": "application/json", ...CORS },
    });
  }
}
