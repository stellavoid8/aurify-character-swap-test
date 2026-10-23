import type { Metadata } from 'next';
import { Urbanist } from 'next/font/google';
import { Toaster } from 'sonner';
import { Backdrop } from '@/components/ui/Backdrop';
import { SCROLL_ROOT_ID } from '@/lib/scroll';
import './globals.css';

const urbanist = Urbanist({ subsets: ['latin'], variable: '--font-sans', display: 'swap' });
const urbanistDisplay = Urbanist({ subsets: ['latin'], variable: '--font-display', display: 'swap' });

export const metadata: Metadata = {
  title: 'Character Swap',
  description: 'Put yourself into any photo moment.',
};

/**
 * One screen: the page itself never scrolls. Content taller than the viewport (phones, long
 * results) scrolls inside the shell, with its scrollbar hidden.
 */
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${urbanist.variable} ${urbanistDisplay.variable} h-dvh overflow-hidden`}>
      <body className="h-dvh overflow-hidden antialiased">
        <Backdrop />
        <div id={SCROLL_ROOT_ID} className="relative z-10 flex h-dvh flex-col overflow-y-auto overscroll-contain scrollbar-none">
          {children}
        </div>
        <Toaster position="top-center" theme="dark" />
      </body>
    </html>
  );
}
