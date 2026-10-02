import { Heart } from "lucide-react";

/** Matches customer-site/components/shell.tsx and its .brand styles. */
export function BrandLogo() {
  return <div className="brand-logo" role="img" aria-label="Tanned by Ffy">
    <span>Tanned<Heart className="brand-logo-heart" size={19} strokeWidth={2} aria-hidden /></span>
    <small>by Ffy</small>
  </div>;
}
