import Navbar from "@/components/Navbar";
import Hero from "@/components/Hero";
import Problem from "@/components/Problem";
import Solution from "@/components/Solution";
import HowItWorks from "@/components/HowItWorks";
import Demo from "@/components/Demo";
import Features from "@/components/Features";
import UseCases from "@/components/UseCases";
import WhyDifferent from "@/components/WhyDifferent";
import Architecture from "@/components/Architecture";
import Hackathon from "@/components/Hackathon";
import Footer from "@/components/Footer";

export default function Home() {
  return (
    <>
      <Navbar />
      <main>
        <Hero />
        <Problem />
        <Solution />
        <HowItWorks />
        <Demo />
        <Features />
        <UseCases />
        <WhyDifferent />
        <Architecture />
        <Hackathon />
      </main>
      <Footer />
    </>
  );
}
