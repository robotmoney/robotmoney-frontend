// The exact wire shape of an oversized batch, so the transport's handling of it
// is written against the real thing rather than an assumption.
const RPC = process.env.BASE_RPC_URL || "https://mainnet.base.org";
const call = (id: number) => ({ jsonrpc: "2.0", id, method: "eth_blockNumber", params: [] });

for (const size of [10, 11]) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "robotmoney-rmpc/1.0" },
    body: JSON.stringify(Array.from({ length: size }, (_, i) => call(i))),
  });
  const body = await res.text();
  const parsed: unknown = JSON.parse(body);
  console.log(
    `size ${String(size).padStart(2)}: HTTP ${res.status}  ${Array.isArray(parsed) ? `array of ${parsed.length}` : "OBJECT"}  ${body.slice(0, 160)}`,
  );
}
