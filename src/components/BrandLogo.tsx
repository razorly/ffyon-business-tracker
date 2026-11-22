import { Heart } from "lucide-react";

/** Her logo. Matches customer-site/components/shell.tsx and its .brand styles; only the size ever changes. */
export function BrandLogo({ size }: { size?: "small" }) {
  return <div className="brand-logo" data-size={size} role="img" aria-label="Tanned by Ffy">
    <span>Tanned<Heart className="brand-logo-heart" size={19} strokeWidth={2} aria-hidden /></span>
    <small>by Ffy</small>
  </div>;
}
