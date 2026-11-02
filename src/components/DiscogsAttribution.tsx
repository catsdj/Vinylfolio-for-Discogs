interface DiscogsAttributionProps {
  href: string;
  className?: string;
}

export default function DiscogsAttribution({ href, className = '' }: DiscogsAttributionProps) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={`text-xs text-muted-foreground underline hover:text-foreground ${className}`.trim()}
    >
      Data provided by Discogs.
    </a>
  );
}
