import { useId, useMemo } from "react";
import { Image } from "react-native";
import Svg, { Defs, LinearGradient, Stop, G, Path } from "react-native-svg";
import { withUnistyles } from "react-native-unistyles";
import { logoPalette, type LogoPalette } from "./vorteo-logo-palette";
import { VORTEO_MARK_PATH } from "./vorteo-mark-path";

interface VorteoLogoProps {
  size?: number;
  color?: string;
}

function LogoArtwork({ size = 64, color, palette }: VorteoLogoProps & { palette: LogoPalette }) {
  const gradientId = `vorteo-${useId().replace(/:/g, "")}`;
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
          y1="6400"
          x2="6400"
          y2="0"
        >
          <Stop offset="0" stopColor={palette.start} />
          <Stop offset="1" stopColor={palette.end} />
        </LinearGradient>
      </Defs>
      <G transform="translate(0 640) scale(0.1 -0.1)">
        <Path d={VORTEO_MARK_PATH} fill={`url(#${gradientId})`} />
      </G>
    </Svg>
  );
}

export const VorteoLogo = withUnistyles(LogoArtwork, (theme) => ({ palette: logoPalette(theme) }));
