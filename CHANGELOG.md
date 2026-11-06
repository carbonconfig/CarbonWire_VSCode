# Changelog

## 1.0.0

The first release of CarbonWire for VS Code, with the same features as CarbonWire 1.1 for Obsidian.

- Send REST requests with query and path parameters, headers, and JSON, XML, text, form, multipart or file bodies.
- Auth: Basic, Bearer token, API key, Digest, OAuth 2.0 (authorization code with PKCE and implicit through your browser, client credentials and password), OAuth 1.0, AWS Signature v4, NTLM, Hawk, Akamai EdgeGrid, JWT Bearer, ASAP and WSSE, set on a request, a folder or a collection.
- Request settings on a request, folder or collection: timeout, redirects, URL encoding, HTTP/1.1 or HTTP/2, certificate checks, TLS versions and cipher suites, cookies and default headers.
- `{{variables}}` from globals, collections, folders, requests and a shared list of environments, with secret values in VS Code's secret storage, and Postman's dynamic values such as `{{$randomEmail}}`.
- Responses as pretty-printed JSON, a JSON tree, an HTML preview, images and PDFs, with headers, cookies, a timing breakdown and TLS details. Filter JSON with JSONPath, save a body to a file, or keep it as a saved example.
- Collections as plain YAML files in the OpenCollection format, found anywhere in the workspace, in a sidebar you can filter, sort and reorder by dragging. Collection and folder docs in Markdown.
- Unsaved requests, saved to a collection when you want to keep them; saved requests save automatically.
- History of every request and response, on this device and outside your repository, and a console showing each request as it was sent.
- A cookie jar with a cookie manager; HTTP, HTTPS and SOCKS5 proxies with authentication; client certificates and your own certificate authorities.
- Code snippets: cURL, HTTP, JavaScript `fetch`, Python `requests` and Go. Header presets.
- Import from Postman, Insomnia, Bruno, HTTPie, Hoppscotch, curl, HAR and `.http` files, including from the Explorer's context menu.
- Export collections as Postman v2.1 or v3, an OpenCollection zip, a cURL script or HAR, and environments as Postman JSON or YAML.
- Paste a curl command into the URL bar, or copy any request as curl.
- Direct connections that are reused between requests, with VS Code's proxy settings used when a proxy is configured (`carbonwire.proxy`).
