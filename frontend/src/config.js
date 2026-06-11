const getBrowserLocation = () => (typeof window !== 'undefined' ? window.location : null);

const stripTrailingColon = (protocol) => (protocol.endsWith(':') ? protocol.slice(0, -1) : protocol);

const buildUrl = (protocol, hostname, port, path = '') => {
  const normalizedProtocol = stripTrailingColon(protocol || 'http:');
  const normalizedPath = path
    ? path.startsWith('/') ? path : `/${path}`
    : '';
  const portSegment = port ? `:${port}` : '';
  return `${normalizedProtocol}://${hostname}${portSegment}${normalizedPath}`;
};

const location = getBrowserLocation();
const defaultHostname = process.env.REACT_APP_DEFAULT_HOST || location?.hostname || 'localhost';
const apiPort = process.env.REACT_APP_API_PORT || '8000';
const httpProtocol = location?.protocol || 'http:';

// Everything - REST, the SSE event stream and action POSTs - goes through
// the one API base URL.
const apiUrl =
  process.env.REACT_APP_API_URL ||
  buildUrl(httpProtocol, defaultHostname, apiPort, '');

const packEditorUrl =
  process.env.REACT_APP_PACK_EDITOR_URL || 'https://packer.critfail.art';

const config = {
  apiUrl,
  packEditorUrl
};

export default config;
