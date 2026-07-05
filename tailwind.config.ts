import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./lib/**/*.{js,ts,jsx,tsx,mdx}"
  ],
  theme: {
    extend: {
      colors: {
        ink: "#18212f",
        line: "#d8dee8",
        paper: "#f7f4ee",
        ocean: "#0d9488",
        coral: "#e85d4f",
        gold: "#d99b2b"
      }
    }
  },
  plugins: []
};

export default config;
