export const metadata = {
  title: "Deployed BD",
  description: "Score and enrich inbound leads from Notion",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          fontFamily:
            "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif",
          background: "#fafaf9",
          color: "#1c1917",
        }}
      >
        <main style={{ maxWidth: 1100, margin: "0 auto", padding: "32px 24px" }}>
          {children}
        </main>
      </body>
    </html>
  );
}
