import PruebaConciliacionShared from "./PruebaConciliacionShared";
import type { Usuario, Local } from "../../types";

interface Props {
  user: Usuario | null;
  locales: Local[];
  localActivo: number | null;
}

export default function PruebaConciliacion1(props: Props) {
  return <PruebaConciliacionShared {...props} source={1} />;
}
