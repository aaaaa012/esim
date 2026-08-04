'use client';
import { useEffect,useState } from 'react';
import { Moon,Sun } from 'lucide-react';
export default function ThemeToggle(){const [dark,setDark]=useState(false);useEffect(()=>{const value=localStorage.getItem('vc-ops-theme')==='dark'||(!localStorage.getItem('vc-ops-theme')&&matchMedia('(prefers-color-scheme: dark)').matches);setDark(value);document.documentElement.dataset.theme=value?'dark':'light'},[]);const toggle=()=>setDark(value=>{const next=!value;document.documentElement.dataset.theme=next?'dark':'light';localStorage.setItem('vc-ops-theme',next?'dark':'light');return next});return <button className="theme-toggle" onClick={toggle} aria-label="Toggle dark mode">{dark?<Sun size={17}/>:<Moon size={17}/>}</button>}
