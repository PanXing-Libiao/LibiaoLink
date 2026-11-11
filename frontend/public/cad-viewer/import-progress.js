/** Observe real received bytes while preserving the core's length/SHA validation. */
export function trackResponse(response, onBytes) {
  if (!response.ok || !response.body) return response;
  const reader = response.body.getReader();
  const body = new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) { controller.close(); reader.releaseLock(); }
        else { onBytes(value.byteLength); controller.enqueue(value); }
      } catch (error) { controller.error(error); reader.releaseLock(); }
    },
    cancel(reason) { return reader.cancel(reason).finally(() => reader.releaseLock()); },
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}
