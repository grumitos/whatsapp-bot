import { botError } from "../log.ts";

export const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/146.0.0.0 Safari/537.36";

type Options = { maxBytes?: number; timeout?: number; headers?: Record<string, string> };

type Guarded = Options & { stop?: (url: URL) => boolean };

const allowed = ({ protocol, port, hostname }: URL, hosts: string[]) =>
  protocol === "https:" && !port && hosts.some((h) => hostname === h || hostname.endsWith(`.${h}`));

export async function guardedFetch(link: string | URL, hosts: string[], options: Guarded = {}) {
  const { maxBytes = 10 * 1024 * 1024, timeout = 60_000, stop } = options;
  const headers = { "User-Agent": USER_AGENT, ...options.headers };
  let url = new URL(link);
  for (let hops = 0; ; hops++) {
    if (!allowed(url, hosts)) throw botError("link_host", `Dominio no permitido: ${url.origin}`);
    if (stop?.(url)) return { url, data: Buffer.alloc(0), type: "" };
    const signal = AbortSignal.timeout(timeout);
    const res = await fetch(url, { headers, redirect: "manual", signal });
    const location = res.status >= 300 && res.status < 400 && res.headers.get("location");
    if (location) {
      if (hops >= 5) throw botError("link_redirects", "Demasiadas redirecciones");
      url = new URL(location, url);
      continue;
    }
    if (!res.ok) throw botError("link_http", `${url.hostname} respondió HTTP ${res.status}`);
    const tooBig = () => botError("link_size", `El archivo supera ${maxBytes / 1048576} MB`);
    if (Number(res.headers.get("content-length")) > maxBytes) throw tooBig();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of res.body!) {
      size += chunk.length;
      if (size > maxBytes) throw tooBig();
      chunks.push(chunk);
    }
    return { url, data: Buffer.concat(chunks), type: res.headers.get("content-type") ?? "" };
  }
}

export async function fetchJson<T>(url: string, hosts: string[], headers?: Record<string, string>) {
  const { data } = await guardedFetch(url, hosts, { headers, timeout: 8000 });
  return JSON.parse(data.toString("utf8")) as T;
}
