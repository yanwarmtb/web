// functions/api/getAbsensi.js
// Endpoint: GET /api/getAbsensi?kelas=KELAS&tanggal=YYYY-MM-DD

const DEFAULT_REPO   = "mrdickymiswardi/server";
const DEFAULT_BRANCH = "main";

const dec = new TextDecoder();
const b64decode = (b64 = "") => {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return dec.decode(bytes);
};

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  });

export const onRequestOptions = () => json({}, 204);

export async function onRequestGet({ request, env }) {
  const TOKEN  = env.GITHUB_TOKEN;
  const REPO   = env.GITHUB_REPO   || DEFAULT_REPO;
  const BRANCH = env.GITHUB_BRANCH || DEFAULT_BRANCH;
  if (!TOKEN) return json({ error: "GITHUB_TOKEN tidak terpasang di environment." }, 500);

  const { searchParams } = new URL(request.url);
  const kelas   = (searchParams.get("kelas")   || "").trim();
  const tanggal = (searchParams.get("tanggal") || "").trim();

  if (!kelas || !tanggal) {
    return json({ error: "Parameter 'kelas' dan 'tanggal' wajib diisi" }, 400);
  }

  const fileName = `${kelas}_${tanggal}.json`;
  const url = `https://api.github.com/repos/${REPO}/contents/absensi/${encodeURIComponent(fileName)}?ref=${encodeURIComponent(BRANCH)}`;

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "cf-pages-getAbsensi/1.0",
    },
  });

  if (res.status === 404) {
    // File belum ada → kembalikan array kosong
    return json([], 200);
  }

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    return json({ source: "github", step: "get", status: res.status, error: t || res.statusText }, 502);
  }

  const meta = await res.json();
  let data = [];
  try { data = JSON.parse(b64decode(meta.content || "")) || []; } catch { data = []; }

  return json(data, 200);
}

export async function onRequest(ctx) {
  const m = ctx.request.method.toUpperCase();
  if (!["GET", "OPTIONS"].includes(m)) return json({ message: "Method Not Allowed" }, 405);
}
