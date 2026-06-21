"use client";

import { motion } from "framer-motion";
import { Search, BookOpen, Layers, Users } from "lucide-react";

const problems = [
  {
    icon: Search,
    title: "Hunting for buttons",
    description:
      "You know what you want to do — you just can't find where to do it. Menus are buried three levels deep and labeled with jargon.",
  },
  {
    icon: BookOpen,
    title: "Leaving the page to find help",
    description:
      "You open a new tab, search YouTube, pause a tutorial at 0.5x speed, then try to remember what you just watched.",
  },
  {
    icon: Layers,
    title: "Software is genuinely overwhelming",
    description:
      "Jira, Salesforce, SAP, enterprise HR tools — they weren't designed to be learned casually. First time in is a wall of icons.",
  },
  {
    icon: Users,
    title: "Teams repeat the same onboarding",
    description:
      "Every new hire, every tool update, someone has to sit down and walk through the same five workflows again.",
  },
];

export default function Problem() {
  return (
    <section
      id="problem"
      className="relative py-32 bg-[#F8FAFC] border-t border-black/[0.05]"
    >
      <div className="max-w-[1280px] mx-auto px-6">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5 }}
          className="max-w-xl mb-16"
        >
          <p className="text-[11px] text-[#2563EB] uppercase tracking-[0.12em] font-semibold mb-4">
            The Problem
          </p>
          <h2 className="text-4xl md:text-5xl font-bold text-[#0F172A] leading-tight tracking-tight mb-4">
            Getting stuck in software is normal. It shouldn&apos;t be.
          </h2>
          <p className="text-[#64748B] text-lg leading-relaxed">
            Every application has a learning curve. The problem isn&apos;t that people
            aren&apos;t smart — it&apos;s that software doesn&apos;t explain itself while
            you&apos;re using it.
          </p>
        </motion.div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {problems.map((problem, i) => {
            const Icon = problem.icon;
            return (
              <motion.div
                key={problem.title}
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.4, delay: i * 0.09 }}
                className="p-6 rounded-xl bg-white border border-black/[0.06] hover:border-black/[0.1] hover:shadow-sm transition-all duration-300"
              >
                <div className="w-10 h-10 rounded-lg bg-[#EBF3FE] flex items-center justify-center mb-5">
                  <Icon className="w-5 h-5 text-[#2563EB]" />
                </div>
                <h3 className="font-semibold text-[#0F172A] text-base mb-2">
                  {problem.title}
                </h3>
                <p className="text-[#64748B] text-sm leading-relaxed">
                  {problem.description}
                </p>
              </motion.div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
