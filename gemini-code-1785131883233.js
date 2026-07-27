'use client';

import React, { useEffect, useRef } from 'react';

export default function FlyingCardsPage() {
  const containerRef = useRef(null);

  // 뉴스/카드 데이터
  const cards = [
    { id: 1, title: "Gemini News 01", desc: "첫 번째 뉴스가 위로 회전하며 날아갑니다.", bg: "linear-gradient(135deg, #ff7e5f, #feb47b)" },
    { id: 2, title: "Gemini News 02", desc: "두 번째 카드입니다.", bg: "linear-gradient(135deg, #6a11cb, #2575fc)" },
    { id: 3, title: "Gemini News 03", desc: "세 번째 카드입니다.", bg: "linear-gradient(135deg, #00c6ff, #0072ff)" },
    { id: 4, title: "Gemini News 04", desc: "마지막 카드입니다.", bg: "linear-gradient(135deg, #f857a6, #ff5858)" },
  ];

  useEffect(() => {
    const handleScroll = () => {
      if (!containerRef.current) return;
      const wrappers = containerRef.current.querySelectorAll('.flying-card-wrapper');

      wrappers.forEach((wrapper) => {
        const card = wrapper.querySelector('.flying-card');
        const rect = wrapper.getBoundingClientRect();
        
        const stickyTop = window.innerHeight * 0.15;
        const scrollProgress = (stickyTop - rect.top) / window.innerHeight;

        if (scrollProgress > 0) {
          const translateY = -scrollProgress * 300;
          const scale = Math.max(1 - scrollProgress * 0.2, 0.8);
          const rotate = -scrollProgress * 8;
          const opacity = Math.max(1 - scrollProgress * 1.5, 0);

          card.style.transform = `translateY(${translateY}px) scale(${scale}) rotate(${rotate}deg)`;
          card.style.opacity = opacity;
        } else {
          card.style.transform = 'translateY(0px) scale(1) rotate(0deg)';
          card.style.opacity = 1;
        }
      });
    };

    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  return (
    <main style={{ backgroundColor: '#0f172a', minHeight: '100vh', color: '#fff' }}>
      <section style={{ height: '70vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
        <h1 style={{ fontSize: '2.5rem', fontWeight: 'bold' }}>Gemini News Stack</h1>
        <p style={{ marginTop: '10px', opacity: 0.7 }}>스크롤을 내려서 카드를 날려보세요 ↓</p>
      </section>

      <div ref={containerRef} style={{ width: '100%', padding: '5vh 0' }}>
        {cards.map((item) => (
          <div
            key={item.id}
            className="flying-card-wrapper"
            style={{
              position: 'sticky',
              top: '15vh',
              height: '70vh',
              display: 'flex',
              justifyContent: 'center',
              alignItems: 'center',
              marginBottom: '20vh',
            }}
          >
            <div
              className="flying-card"
              style={{
                width: '85%',
                maxWidth: '600px',
                height: '380px',
                borderRadius: '24px',
                padding: '40px',
                background: item.bg,
                color: '#ffffff',
                boxShadow: '0 20px 50px rgba(0,0,0,0.4)',
                transformOrigin: 'center top',
                willChange: 'transform, opacity',
                transition: 'transform 0.1s linear, opacity 0.1s linear',
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'space-between'
              }}
            >
              <h2 style={{ fontSize: '2rem', fontWeight: 'bold' }}>{item.title}</h2>
              <p style={{ fontSize: '1.1rem', opacity: 0.9 }}>{item.desc}</p>
            </div>
          </div>
        ))}
      </div>

      <section style={{ height: '50vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <p style={{ fontSize: '1.2rem', opacity: 0.5 }}>End of Cards</p>
      </section>
    </main>
  );
}