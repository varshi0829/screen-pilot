import { Navigation2, Github } from "lucide-react";

const footerLinks = [
  { label: "Features", href: "#features" },
  { label: "How It Works", href: "#how-it-works" },
  { label: "Demo", href: "#demo" },
  { label: "Architecture", href: "#architecture" },
  {
    label: "GitHub",
    href: "https://github.com/varshi0829/screen-pilot",
    external: true,
  },
];

const techStack = [
  "Chrome Extensions MV3",
  "Gemini 2.5 Flash",
  "JavaScript",
  "Next.js 15",
];

export default function Footer() {
  return (
    <footer className="bg-[#F8FAFC] border-t border-black/[0.06]">
      <div className="max-w-[1280px] mx-auto px-6 py-12">
        <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-8">
          {/* Logo + tagline */}
          <div className="flex flex-col gap-3">
            <a href="#" className="flex items-center gap-2.5">
              <div className="w-7 h-7 rounded-lg bg-[#2563EB] flex items-center justify-center">
                <Navigation2 className="w-3.5 h-3.5 text-white" />
              </div>
              <span className="font-semibold text-[#0F172A] text-sm tracking-tight">
                ScreenPilot
              </span>
            </a>
            <p className="text-xs text-[#64748B] max-w-xs leading-relaxed">
              Click the extension. Type what you want. Follow the highlight.
            </p>
          </div>

          {/* Links */}
          <nav className="flex flex-wrap items-center gap-1">
            {footerLinks.map((link) => (
              <a
                key={link.label}
                href={link.href}
                target={link.external ? "_blank" : undefined}
                rel={link.external ? "noopener noreferrer" : undefined}
                className="px-3 py-2 text-xs text-[#64748B] hover:text-[#0F172A] transition-colors rounded-md hover:bg-black/[0.04]"
              >
                {link.label}
              </a>
            ))}
          </nav>

          {/* Download CTA */}
          <a
            href="/screenpilot-extension.zip"
            download="screenpilot-extension.zip"
            className="inline-flex items-center gap-2 px-4 py-2 border border-black/[0.08] text-[#64748B] text-xs font-medium rounded-lg hover:text-[#0F172A] hover:border-black/[0.14] transition-all"
          >
            <Github className="w-3.5 h-3.5" />
            Install Extension
          </a>
        </div>

        {/* Bottom bar */}
        <div className="mt-10 pt-6 border-t border-black/[0.05] flex flex-col sm:flex-row items-center justify-between gap-4">
          <p className="text-[11px] text-[#94A3B8]">
            Open source · MIT license · Hackathon 2024
          </p>
          <div className="flex items-center gap-2 flex-wrap justify-center">
            <span className="text-[11px] text-[#94A3B8]">Built with</span>
            {techStack.map((tech, i) => (
              <span key={tech} className="flex items-center gap-2">
                <span className="text-[11px] text-[#64748B] font-medium">{tech}</span>
                {i < techStack.length - 1 && (
                  <span className="text-[#CBD5E1] text-[11px]">·</span>
                )}
              </span>
            ))}
          </div>
        </div>
      </div>
    </footer>
  );
}
