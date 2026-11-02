import { Suspense } from 'react';
import DiscogsCollection from '@/components/DiscogsCollection';

export default function Home() {
  return (
    <div className="min-h-screen bg-muted/30 p-4">
      <div className="mx-auto max-w-[calc(100vw-40px)] px-2 sm:px-4">
        <header className="text-center mb-8">
          <h1 className="text-4xl font-bold mb-2">VinylFolio</h1>
          <p className="text-lg text-muted-foreground">
            Browse and filter your vinyl collection the way Discogs can&apos;t
          </p>
        </header>

        <main>
          <Suspense fallback={<div className="py-8 text-center text-muted-foreground">Loading collection…</div>}>
            <DiscogsCollection />
          </Suspense>
        </main>

        <footer className="mt-8 rounded-md border bg-background/70 p-3 text-xs text-muted-foreground">
          <p>
            Data provided by{' '}
            <a
              href="https://www.discogs.com/"
              target="_blank"
              rel="noopener noreferrer"
              className="underline"
            >
              Discogs
            </a>
            . This application uses Discogs&apos; API but is not affiliated with, sponsored or endorsed by Discogs.
            &nbsp;&ldquo;Discogs&rdquo; is a trademark of Zink Media, LLC.
          </p>
        </footer>
      </div>
    </div>
  );
}
