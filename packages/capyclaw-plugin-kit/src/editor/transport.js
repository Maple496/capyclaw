/** 编辑器 → relay 的最小传输层；页面逻辑不关心 fetch/JSON 细节。 */
export function createTransport(basePath, fetchImpl = (...args) => fetch(...args)) {
  const api = (path, options) => fetchImpl(basePath + path, options).then((response) => response.json())
  return {
    api,
    get: (path) => api(path),
    post: (path, body) => api(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  }
}
