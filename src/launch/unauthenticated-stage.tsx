import { SignIn } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";

interface UnauthenticatedStageProps {
  isLaunchingAuth: boolean;
  onAuthRedirect: (kind: "sign-in" | "sign-up") => void;
}

export function UnauthenticatedStage({
  isLaunchingAuth,
  onAuthRedirect,
}: UnauthenticatedStageProps) {
  return (
    <main className="h-screen w-screen overflow-hidden bg-[#171717] text-white">
      <section className="absolute left-[clamp(1.5rem,2.5vw,3rem)] top-[clamp(2rem,8.2vh,7rem)] z-10">
        <h1 className="flex flex-col font-sans text-[clamp(3.5rem,5.8vw,7rem)] font-light leading-[0.98] tracking-[-0.085em]">
          <span>Welcome</span>
          <span className="mt-[0.18em] text-[#777]">Pipper code</span>
        </h1>

        <Button
          type="button"
          variant="primary"
          size="lg"
          leadingIcon={SignIn}
          onClick={() => onAuthRedirect("sign-in")}
          disabled={isLaunchingAuth}
          className="mt-[clamp(3.25rem,8.5vh,7rem)] min-w-[140px]"
        >
          {isLaunchingAuth ? "Opening browser…" : "Sign in"}
        </Button>
      </section>
    </main>
  );
}
