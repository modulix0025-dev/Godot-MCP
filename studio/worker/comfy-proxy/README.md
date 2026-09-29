# Reference authenticating proxy for ComfyUI workers

ComfyUI has no built-in authentication. The Studio refuses a remote worker that answers without credentials:
worker onboarding fails the `authentication` step, and the worker stays UNTRUSTED.

1. Start ComfyUI on loopback only: `python main.py --listen 127.0.0.1 --port 8188`.
2. Run Caddy with this `Caddyfile`. It provides TLS (automatic certificates) and a bearer token, and it closes
   ComfyUI-Manager and the user-data routes.
3. In the Studio, go to **Workers → Add worker** and choose the transport `https-auth-proxy`, the URL
   `https://<COMFY_DOMAIN>` and the token. The token goes into Windows Credential Manager. It is never stored
   in the Studio database, logs or project files.

Alternatives that meet the same rule: Tailscale, an SSH tunnel (`ssh -L 8188:127.0.0.1:8188 gpu-host`,
with the transport `ssh-tunnel` and the URL `http://127.0.0.1:8188`), or a private network. Never open port
8188 to the internet.
