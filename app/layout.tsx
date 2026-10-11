import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import Script from "next/script";
import "./globals.css";
import SiteChrome from "../components/SiteChrome";

const inter = Inter({ subsets: ["latin"], display: "swap" });

export const metadata: Metadata = {
  metadataBase: new URL("https://growgreenlab.com"),
  title: {
    default: "Trade Replay Lab — Practice Day Trading Risk-Free | Grow Green Lab",
    template: "%s | Grow Green Lab",
  },
  description:
    "Replay historical stock market sessions candle by candle. Practice HOD breakout, EMA and VWAP pullback strategies with simulated orders, stop-loss and take-profit — no real money at risk.",
  keywords: [
    "stock market simulator",
    "trading replay",
    "paper trading",
    "day trading practice",
    "HOD breakout strategy",
    "penny stock simulator",
    "candle replay",
    "trading backtest",
    "premarket trading practice",
  ],
  authors: [{ name: "Grow Green Lab" }],
  creator: "Grow Green Lab",
  icons: { icon: "/growgreenlab-logo.png" },
  openGraph: {
    type: "website",
    locale: "en_US",
    url: "https://growgreenlab.com",
    siteName: "Grow Green Lab",
    title: "Trade Replay Lab — Practice Day Trading Risk-Free",
    description:
      "Replay historical market sessions candle by candle. Practice breakout strategies with simulated orders — no real money at risk.",
    images: [
      {
        url: "/sim-preview.png",
        width: 1200,
        height: 630,
        alt: "Trade Replay Lab simulator preview",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Trade Replay Lab — Practice Day Trading Risk-Free",
    description:
      "Replay historical market sessions candle by candle. Practice breakout strategies with simulated orders.",
    images: ["/sim-preview.png"],
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-video-preview": -1,
      "max-image-preview": "large",
      "max-snippet": -1,
    },
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover",
  // Makes iOS resize the layout when the keyboard opens
  // instead of overlaying it (supported in iOS 16+ via meta name)
  interactiveWidget: "resizes-content",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "WebApplication",
    name: "Trade Replay Lab",
    url: "https://growgreenlab.com",
    applicationCategory: "FinanceApplication",
    operatingSystem: "Web",
    offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
    description:
      "Replay historical stock market sessions candle by candle and practice day trading strategies with simulated orders.",
    publisher: {
      "@type": "Organization",
      name: "Grow Green Lab",
      url: "https://growgreenlab.com",
      logo: "https://growgreenlab.com/growgreenlab-logo.png",
    },
  };
  return (
    <html lang="en" className={inter.className}>
      <head>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />
        <link rel="canonical" href="https://growgreenlab.com" />
        {/* Google Analytics */}
        <Script
          src="https://www.googletagmanager.com/gtag/js?id=G-KRK0LVTTGS"
          strategy="afterInteractive"
        />
        <Script id="google-analytics" strategy="afterInteractive">
          {`
            window.dataLayer = window.dataLayer || [];
            function gtag(){dataLayer.push(arguments);}
            gtag('js', new Date());
            gtag('config', 'G-KRK0LVTTGS');
          `}
        </Script>
      </head>
      <body>
        <SiteChrome>{children}</SiteChrome>
      </body>
    </html>
  );
}
