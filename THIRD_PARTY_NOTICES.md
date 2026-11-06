# Third-party notices

## Go dependencies

Pinned Go dependencies and their licenses are retained under `vendor/`.
The go-ipmi client includes a local KG-key setter and regression test;
see [vendor patch maintenance](docs/vendor-patches.md). Its existing RAKP
cryptography and protocol implementation are unchanged.

## Dashboard layout

GridStack 14.0.0 is used as a dependency with its included React wrapper.
MIT License, copyright (c) 2019-2025 Alain Dumesny; v0.4.0 and older
(c) 2014-2018 Pavel Reznikov, Dylan Weiss. The complete license is retained in
`docs/licenses/gridstack-MIT.txt`. Source: https://github.com/gridstack/gridstack.js.
No IPMIDeck implementation is included.

## Dell graphical console

noVNC 1.7.0 supplies the browser RFB client, under MPL-2.0.
Source: https://github.com/novnc/noVNC/tree/v1.7.0. The dependency and exact
integrity are recorded in `web/package-lock.json`; corresponding source is
available from that tag and the npm package. Notices, MPL text, bundled pako
MIT license and legacy DES notices are retained under `docs/licenses/novnc-*`.
The noVNC application UI, fonts and images are not included.
`web/vite.config.ts` modifies `core/rfb.js` at build/dev time to omit its
TightPNG advertisement: iDRAC7 stalls when that format is offered. All other
encodings and decoders remain unchanged. The exact source-match guard and
protocol test must be requalified when upgrading noVNC. The reproducible
modification is included with this application's source.

## Serial console

xterm.js 6.0.0 and its fit addon 0.11.0 provide the browser terminal, under the
MIT license. Source: https://github.com/xtermjs/xterm.js. Complete licenses are
retained in `docs/licenses/xterm-MIT.txt` and `docs/licenses/xterm-fit-MIT.txt`.

`web/src/kvm.ts` and `web/src/hid.ts` adapt JetKVM stock frontend protocol and
USB key mappings from https://github.com/jetkvm/kvm at commit
`d646be873a136f1d7c2ec743e6fe826e43c65b30`.
Copyright JetKVM contributors. Licensed under GNU GPL version 2;
the complete upstream license is retained in `LICENSE`. The adaptations replace
React/Zustand hook integration with a small browser provider, authenticated
same-origin signaling relay, bounded reconnects, guarded asynchronous callbacks
and request timeouts. Source paths are recorded in `docs/jetkvm-protocol.md`.

Distribute corresponding source with distributed application builds as required
by GPL-2.0. Dependency licenses also apply; consult package lock and module files.

## Branding assets

- `web/src/assets/assistant-brain.png`: the operator-supplied AI brain artwork, bundled locally for the optional assistant.

- `web/src/assets/jetkvm.svg`: unchanged official `ui/src/assets/logo-white.svg`
  from the pinned JetKVM commit above.
- `web/src/assets/supermicro.svg`: unchanged official green-orbit vector logo,
  downloaded 2026-11-02 from
  https://www.supermicro.com/sites/default/files/Super_Micro_Computer_Logo.svg.
  Transparent outside its original white oval; no added background or recoloring.
  [Supermicro brand reference](https://www.supermicro.com/en/supermicro-logos).
- `web/src/assets/finch13.png`: Finch13 project logo, reproduced with the maintainer's permission.

These marks identify the owner and connected hardware. Vendor trademarks remain
with their respective owners; this independent project does not imply vendor
endorsement. Images are bundled locally, with no third-party image requests.

- `web/src/assets/dell.svg`: Simple Icons Dell mark at commit
  `90646e4bf7f3b89df6c37e65baf3e7bc759a517c`, CC0-1.0.
  Source: https://github.com/simple-icons/simple-icons/blob/90646e4bf7f3b89df6c37e65baf3e7bc759a517c/icons/dell.svg.
  License retained in `docs/licenses/simple-icons-CC0.txt`; Dell trademark rights remain with Dell.

## Remote display preview

The branding JPEGs, transmission pictogram and two resting knife-switch poses
in `web/src/assets/panel/` come from [iBORK-ESP32 firmware artwork](https://github.com/akira69/iBORK-ESP32/tree/d84d2dc11f97fc0711bd573047690711457e5297/art).
The firmware is licensed under GPL-2.0. The iBORK and Finch13 marks identify
the project. The Settings gear includes Lucide artwork under the notices in
`docs/licenses/panel-settings-lucide.txt`.
