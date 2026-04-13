export const onRequest: PagesFunction = async (context) => {
  const url = new URL(context.request.url);
  const target = new URL(url.pathname + url.search, 'https://rocchat-api.spoass.workers.dev');

  const req = new Request(target.toString(), {
    method: context.request.method,
    headers: context.request.headers,
    body: context.request.body,
  });

  return fetch(req);
};
