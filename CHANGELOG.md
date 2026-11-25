# Changelog

## Unreleased

- A request's new **Tests** tab checks the response without code, such as `res.status` equals 200, and takes values from it into variables, such as `$.token` after a login. Results show in the response's Tests tab. Variables are kept until restart, or written to the active environment, the collection, a folder or the request. Right-click a value in the JSON tree and choose **Save as variable…** to start one.
- Checks and post-response variables in Bruno collections are now imported and run, instead of being skipped.
- Typing `{{` suggests the variables in scope, with their values; `{{$` suggests the dynamic values. Header names and their usual values are suggested as you type them.
- **CarbonWire: Go to request** finds any request by name, collection or folder. It's also in the CarbonWire sidebar's menu; assign it a keyboard shortcut if you like.
- Bulk edit params, headers and form fields as `name: value` lines.
- JSON bodies are checked as you type. A mistake, such as a missing comma or an unclosed bracket, is underlined where it is and described below the editor; select the description to go to it. Comments and unquoted `{{variables}}` are accepted, as they're handled before sending.
- Format JSON now works on bodies with comments and unquoted `{{variables}}`, keeping them where they are. With a mistake in the body, it goes to the mistake instead.
- Hover a `{{variable}}` to see its value and where it's set: the environment, globals, the collection, a folder or the request. Secret values stay masked. `Ctrl+Click` (`Cmd+Click`) opens it there to edit, or adds one that isn't set to the active environment.
- Importing a whole Postman data export first lists its collections and environments, all ticked, so you can leave some out.
- Collections in hidden folders, such as `.vscode-test`, are no longer listed, nor those in folders `files.exclude` hides. The new `carbonwire.exclude` setting leaves out more, such as `**/tests/fixtures`.
- The list of files CarbonWire has read is kept in the extension's storage folder instead of the workspace state, which VS Code warned about in workspaces with thousands of requests.

## 1.2.0

- Hover an item in the sidebar to see where it's saved. Its menu copies the full path or shows the file in the Explorer view or your file manager.
- The active environment shows beside the request name, above Send, and Send takes the environment's colour.
- Environments are read from every workspace folder, so moving `api-collections` to another folder of the workspace no longer hides them. Same-named environments in several folders are merged: each variable takes the first value that isn't empty.
- The environments folder setting follows the folder when you move or rename it in VS Code.
- The split between request and response stays where you dragged it, when you switch tabs and after a restart.
- A tab left blank after CarbonWire is updated or restarted now says so, and how to get it back.

## 1.1.0

- Import a whole Postman account in one go: the zip from Postman's data export, or its unzipped folder, brings in every collection, environment and the globals. Older single-file dumps and v1 collections work too.
- Postman globals now become CarbonWire's globals instead of an environment.
- Comment out lines of a JSON body with `Ctrl+/` (`Cmd+/`). Commented lines aren't sent, and a comma they leave before a closing bracket is dropped.
- Cancel a request from the response pane, or with `Escape` there. A cancelled request says how long it ran, with a button to send it again.
- A request opens on the first of Body, Params, Auth and Headers that has something in it.
- Each request tab remembers its request and response tabs, the response view and the JSONPath filter, when you switch back to it and after a restart.

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
