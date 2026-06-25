import {
  SiDebian,
  SiUbuntu,
  SiFedora,
  SiArchlinux,
  SiAlpinelinux,
  SiLinux,
  SiRockylinux,
  SiAlmalinux,
  SiCentos,
  SiRedhat,
  SiOpensuse,
  SiDocker,
  SiProxmox,
} from "react-icons/si";
import { Package } from "lucide-react";
import { cn } from "@/lib/utils";

type BrandIcon = React.ComponentType<{ className?: string; style?: React.CSSProperties; "aria-hidden"?: boolean }>;

// OS label (case-insensitive substring) → brand logo + a theme-readable color.
// First match wins, so list specific distros before the generic "linux".
const OS_ICONS: Array<{ re: RegExp; Icon: BrandIcon; color: string }> = [
  { re: /ubuntu/, Icon: SiUbuntu, color: "#E95420" },
  { re: /debian/, Icon: SiDebian, color: "#D70A53" },
  { re: /fedora/, Icon: SiFedora, color: "#3B82F6" },
  { re: /rocky/, Icon: SiRockylinux, color: "#10B981" },
  { re: /alma/, Icon: SiAlmalinux, color: "#3B82F6" },
  { re: /cent\s?os/, Icon: SiCentos, color: "#A855F7" },
  { re: /red\s?hat|rhel/, Icon: SiRedhat, color: "#EE0000" },
  { re: /arch/, Icon: SiArchlinux, color: "#1793D1" },
  { re: /alpine/, Icon: SiAlpinelinux, color: "#0EA5E9" },
  { re: /suse/, Icon: SiOpensuse, color: "#73BA25" },
  { re: /docker/, Icon: SiDocker, color: "#2496ED" },
  { re: /proxmox/, Icon: SiProxmox, color: "#E57000" },
  { re: /linux/, Icon: SiLinux, color: "#F59E0B" },
];

/**
 * Icon for a template: an admin-uploaded custom image if present, otherwise a
 * logo matched to the template's OS, otherwise a generic package fallback.
 */
export function TemplateIcon({
  os,
  name,
  icon,
  className,
}: {
  os?: string | null;
  /** Used to guess the distro when no OS label is set (e.g. "debian-template-test"). */
  name?: string | null;
  icon?: string | null;
  className?: string;
}) {
  if (icon) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={icon} alt="" className={cn("object-contain", className)} />;
  }
  const text = (os || name || "").toLowerCase();
  const match = text ? OS_ICONS.find((o) => o.re.test(text)) : undefined;
  if (match) {
    const { Icon, color } = match;
    return <Icon className={className} style={{ color }} aria-hidden />;
  }
  return <Package className={className} aria-hidden />;
}

/**
 * Read an uploaded image file into a small icon data-URI suitable for storage.
 * Raster images are downscaled (max edge `max` px) and re-encoded as PNG; SVGs
 * are kept as vectors but size-capped. Rejects non-images / oversized SVGs.
 */
export function fileToIconDataUrl(file: File, max = 96): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith("image/")) {
      reject(new Error("Please choose an image file (PNG, JPG, WebP, or SVG)."));
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read the file."));
    reader.onload = () => {
      const dataUrl = reader.result as string;
      if (file.type === "image/svg+xml") {
        if (dataUrl.length > 300_000) reject(new Error("That SVG is too large (max ~300 KB)."));
        else resolve(dataUrl);
        return;
      }
      const img = new Image();
      img.onerror = () => reject(new Error("Could not load the image."));
      img.onload = () => {
        const scale = Math.min(1, max / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          reject(new Error("Image processing isn't supported in this browser."));
          return;
        }
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL("image/png"));
      };
      img.src = dataUrl;
    };
    reader.readAsDataURL(file);
  });
}
