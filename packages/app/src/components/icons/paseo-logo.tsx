import { useId, useMemo } from "react";
import { Image } from "react-native";
import Svg, {
  Defs,
  LinearGradient,
  Stop,
  G,
  Mask,
  Rect,
  Image as SvgImage,
  type MaskProps,
} from "react-native-svg";
import { withUnistyles } from "react-native-unistyles";
import { logoPalette, type LogoPalette } from "./vorteo-logo-palette";

const silhouetteMaskStyle: MaskProps["style"] = { maskType: "alpha" };
const shadingMaskStyle: MaskProps["style"] = { maskType: "luminance" };

interface VorteoLogoProps {
  size?: number;
  color?: string;
}

function LogoArtwork({ size = 64, color, palette }: VorteoLogoProps & { palette: LogoPalette }) {
  const gradientId = `vorteo-${useId().replace(/:/g, "")}`;
  const silhouetteId = `${gradientId}-silhouette`;
  const shadingId = `${gradientId}-shading`;
  const whiteArtwork = require("../../../assets/brand/vorteo-white.png");
  const imageStyle = useMemo(
    () => ({ width: size, height: size, ...(color ? { tintColor: color } : {}) }),
    [size, color],
  );
  if (color || palette.mode !== "gradient") {
    const source =
      !color && palette.mode === "rainbow"
        ? require("../../../assets/brand/vorteo-color.png")
        : require("../../../assets/brand/vorteo-white.png");
    return (
      <Image source={source} style={imageStyle} resizeMode="contain" accessibilityLabel="Vorteo" />
    );
  }
  return (
    <Svg width={size} height={size} viewBox="0 0 640 640" accessibilityLabel="Vorteo">
      <Defs>
        <LinearGradient
          id={gradientId}
          gradientUnits="userSpaceOnUse"
          x1="0"
          y1="0"
          x2="640"
          y2="640"
        >
          <Stop offset="0" stopColor={palette.start} />
          <Stop offset="1" stopColor={palette.end} />
        </LinearGradient>
        <Mask
          id={silhouetteId}
          style={silhouetteMaskStyle}
          x="0"
          y="0"
          width="640"
          height="640"
          maskUnits="userSpaceOnUse"
        >
          <SvgImage href={whiteArtwork} width="640" height="640" />
        </Mask>
        <Mask
          id={shadingId}
          style={shadingMaskStyle}
          x="0"
          y="0"
          width="640"
          height="640"
          maskUnits="userSpaceOnUse"
        >
          <SvgImage href={whiteArtwork} width="640" height="640" />
        </Mask>
      </Defs>
      {/* The master's luminance keeps the hidden turn shaded in every palette. */}
      <G mask={`url(#${silhouetteId})`}>
        <Rect width="640" height="640" fill="black" />
        <Rect width="640" height="640" fill={`url(#${gradientId})`} mask={`url(#${shadingId})`} />
      </G>
    </Svg>
  );
}

export const VorteoLogo = withUnistyles(LogoArtwork, (theme) => ({ palette: logoPalette(theme) }));
