# Integration brand icon

Home Assistant shows an integration's logo/icon from the central
[`home-assistant/brands`](https://github.com/home-assistant/brands) repository —
there is **no** way to ship a brand icon inside a custom-component folder. The
files here are ready to submit.

`custom_integrations/dars_remote_id/`
- `icon.png` — 256×256 (square, transparent)
- `icon@2x.png` — 512×512
- `logo.png` — used where a wider logo is shown

## To make HA display the icon
1. Fork **home-assistant/brands**.
2. Copy this repo's `brands/custom_integrations/dars_remote_id/` folder into the
   fork at the same path (`custom_integrations/dars_remote_id/`).
3. Open a pull request. Once merged, Home Assistant loads the icon for the
   `dars_remote_id` domain automatically (from `brands.home-assistant.io`) — in
   Settings → Devices & Services, the device page, and HACS.

Until that PR is merged, HA shows a generic placeholder for the integration;
this does not affect functionality.
