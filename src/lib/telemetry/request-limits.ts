/**
 * Payload-size guard for POST /v1/observe — a public, unauthenticated-by-design
 * endpoint that any vendor's installed script (or anyone else) can hit.
 */

/**
 * The wire body is five short fields (see events.ts's `ObservePayload`) — a
 * legitimate request is well under 512 bytes. 8 KiB is generous headroom for
 * an unusual unicode domain or extra JSON whitespace, while still bounding
 * how much a single request can force this endpoint to buffer.
 */
export const MAX_OBSERVE_BODY_BYTES = 8 * 1024;

/**
 * Reads the body up to `maxBytes`, aborting the stream — not just discarding
 * the result — the moment it's exceeded. A `Content-Length` check alone
 * doesn't defend against a chunked request that lies about (or omits) its
 * length, and buffering the whole body before checking its size defeats the
 * point of a cap. Returns `undefined` on anything over the limit, matching
 * the existing "malformed body" contract this route already has.
 */
export async function readBodyWithLimit(request: Request, maxBytes: number): Promise<string | undefined> {
	const declaredLength = request.headers.get("content-length");
	if (declaredLength && Number(declaredLength) > maxBytes) return undefined;

	const reader = request.body?.getReader();
	if (!reader) return request.text();

	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > maxBytes) {
			await reader.cancel().catch(() => undefined);
			return undefined;
		}
		chunks.push(value);
	}

	return new TextDecoder().decode(concatChunks(chunks, total));
}

function concatChunks(chunks: Uint8Array[], total: number): Uint8Array {
	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return out;
}
