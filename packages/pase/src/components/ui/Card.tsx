import type { ReactNode } from "react";
import styles from "./Card.module.css";

type CardProps = {
  children: ReactNode;
  className?: string;
};

export function Card({ children, className }: CardProps) {
  const cls = className ? `${styles.card} ${className}` : styles.card;
  return <div className={cls}>{children}</div>;
}
