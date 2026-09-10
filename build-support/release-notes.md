Download the ZIP for your browser and extract it into a folder you will keep:

- **Brave / Chromium:** download `quarantine-chromium.zip`, enable Developer mode in `brave://extensions` or `chrome://extensions`, choose **Load unpacked**, and select the extracted folder.
- **Firefox:** download `quarantine-firefox.zip`, open `about:debugging#/runtime/this-firefox`, choose **Load Temporary Add-on**, and select `manifest.json` in the extracted folder. This unsigned development installation lasts until Firefox closes; permanent installation requires Mozilla signing.

Right-click the toolbar icon to open Quarantine settings. Hold for 10 seconds to configure it. Global quarantine starts disabled, with no page rules. Left-click the toolbar icon to lock everything again.

`SHA256SUMS` and `build-info.json` identify the reproducible unsigned ZIPs and their source commit. See the README for usage, local testing, and independent build verification.
