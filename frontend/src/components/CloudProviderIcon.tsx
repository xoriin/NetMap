import { Cloud, Globe2 } from "lucide-react";
import { IconBrandCloudflare } from "@tabler/icons-react";

import awsIcon from "../assets/providers/aws.svg";
import azureIcon from "../assets/providers/azure.svg";
import googleCloudIcon from "../assets/providers/google-cloud.svg";
import type { CloudProviderIcon as CloudProviderIconKey } from "../api/client";

/**
 * Renders a cloud provider's mark.
 *
 * Providers are rows in `cloud_providers`, so the icon is read from the single
 * provider record rather than being copied onto everything that references it.
 * `custom` pairs with an uploaded data URI; every other value is a bundled mark.
 *
 * `size` binds the bundled SVGs as well as the icon-font marks. It used to apply only
 * to the latter, which left the `<img>` cases sized by the SVG's own viewBox — outside
 * a caller that happened to constrain `img`, a provider logo rendered full-page.
 */
export function CloudProviderIcon({ icon, iconData, size = 23 }: {
  icon: CloudProviderIconKey | undefined | null;
  iconData?: string | null;
  size?: number;
}) {
  const imageStyle = { width: size, height: size, objectFit: "contain" as const, display: "block" };
  if (icon === "custom" && iconData) return <img src={iconData} alt="" style={imageStyle} />;
  switch (icon) {
    case "aws": return <img src={awsIcon} alt="" style={imageStyle} />;
    case "azure": return <img src={azureIcon} alt="" style={imageStyle} />;
    case "google_cloud": return <img src={googleCloudIcon} alt="" style={imageStyle} />;
    case "cloudflare": return <IconBrandCloudflare size={size} />;
    case "globe": return <Globe2 size={size} />;
    default: return <Cloud size={size} />;
  }
}
