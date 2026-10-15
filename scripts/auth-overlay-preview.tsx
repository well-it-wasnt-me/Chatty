import React from 'react';
import { render } from 'ink';
import { AuthOverlay } from '../src/ui/overlays/AuthOverlay.js';
import { chooseTheme } from '../src/ui/theme/colors.js';
import { qrToLines } from '../src/ui/qr.js';

// Renders the auth overlay once and exits - used to eyeball QR display.
const theme = chooseTheme();
const instance = render(
  <AuthOverlay
    theme={theme}
    height={20}
    accountLabel="WhatsApp (personal)"
    prompt={{ kind: 'qr', data: 'demo://pair/whatsapp-a?secret=not-a-real-secret' }}
    qrLines={qrToLines('demo://pair/whatsapp-a?secret=not-a-real-secret')}
    onSubmit={() => {}}
    onClose={() => {}}
  />,
);
setTimeout(() => instance.unmount(), 100);
