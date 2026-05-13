import type { ReactNode } from "react";
import styles from "./Bento.module.css";

type BentoProps = {
  children: ReactNode;
  className?: string;
};

export function Bento({ children, className }: BentoProps) {
  const cls = className ? `${styles.bento} ${className}` : styles.bento;
  return <div className={cls}>{children}</div>;
}
