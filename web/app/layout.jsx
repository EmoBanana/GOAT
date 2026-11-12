import { Archivo, IBM_Plex_Mono } from 'next/font/google';
import './globals.css';

// Archivo's width axis gives the headings their expanded cut; Plex Mono is for keys, labels and code.
const archivo = Archivo({ subsets: ['latin'], axes: ['wdth'], variable: '--font-archivo', display: 'swap' });
const plexMono = IBM_Plex_Mono({ subsets: ['latin'], weight: ['400', '500', '600'], variable: '--font-plex-mono', display: 'swap' });

export const metadata = {
  title: 'GOAT for Mac and Windows',
  description: 'A second cursor that shows you where to click. It flies to each button in order and tells you what to do.',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" className={`${archivo.variable} ${plexMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
