import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, LineChart, Line, Legend, CartesianGrid } from "recharts";

interface EvolucionRow {
  mes: string;
  Ventas: number;
  CMV: number;
  "Sueldos + CS": number;
  "Util. Neta": number;
}

export function EvolucionChart({ data }: { data: EvolucionRow[] }) {
  return (
    <ResponsiveContainer width="100%" height={220}>
      <LineChart data={data} margin={{top:8,right:24,left:8,bottom:0}}>
        <CartesianGrid stroke="var(--bd2)" strokeDasharray="3 3"/>
        <XAxis dataKey="mes" tick={{fontSize:10,fill:"var(--muted)"}} axisLine={{stroke:"var(--bd2)"}} tickLine={false}/>
        <YAxis tick={{fontSize:10,fill:"var(--muted)"}} axisLine={false} tickLine={false} tickFormatter={(v)=>{
          const n = Number(v);
          if (Math.abs(n) >= 1_000_000) return (n/1_000_000).toFixed(1)+"M";
          if (Math.abs(n) >= 1_000) return Math.round(n/1_000)+"k";
          return String(n);
        }}/>
        <Tooltip
          contentStyle={{background:"var(--s1)",border:"1px solid var(--bd2)",borderRadius:6,fontSize:11}}
          formatter={(v)=>[`$${Number(v).toLocaleString("es-AR")}`] as [string]}
        />
        <Legend wrapperStyle={{fontSize:11}}/>
        <Line type="monotone" dataKey="Ventas" stroke="var(--success)" strokeWidth={2} dot={{r:3}} />
        <Line type="monotone" dataKey="CMV" stroke="var(--warn)" strokeWidth={2} dot={{r:3}} />
        <Line type="monotone" dataKey="Sueldos + CS" stroke="var(--danger)" strokeWidth={2} dot={{r:3}} />
        <Line type="monotone" dataKey="Util. Neta" stroke="var(--acc)" strokeWidth={2} dot={{r:3}} />
      </LineChart>
    </ResponsiveContainer>
  );
}

interface CategoriaRow { cat: string; monto: number }

export function CategoriaCMVChart({ data }: { data: CategoriaRow[] }) {
  return (
    <ResponsiveContainer width="100%" height={120}>
      <BarChart data={data} margin={{top:0,right:8,left:0,bottom:0}}>
        <XAxis dataKey="cat" tick={{fontSize:9,fill:"var(--muted)"}} axisLine={false} tickLine={false}/>
        <YAxis hide/>
        <Tooltip
          contentStyle={{background:"var(--s1)",border:"1px solid var(--bd2)",borderRadius:6,fontSize:11}}
          formatter={(v)=>[`$${Number(v).toLocaleString("es-AR")}`, "CMV"] as [string, string]}
        />
        <Bar dataKey="monto" radius={[4,4,0,0]} fill="var(--pase-celeste)"/>
      </BarChart>
    </ResponsiveContainer>
  );
}
