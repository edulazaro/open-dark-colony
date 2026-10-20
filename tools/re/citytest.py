import sys; sys.path.insert(0,'.re/py')
from fin import load_fin
from spr import load_spr
from PIL import Image, ImageDraw
D='C:/code/DCOLONY/'
sprs={}
def sp(n):
    if n not in sprs: sprs[n]=load_spr(D+'SPRITES/'+n.upper()+'.SPR')
    return sprs[n]
fins={}
def anim(fn,name):
    if fn not in fins: fins[fn]=load_fin(D+'ANIMATE/'+fn+'.FIN')
    f=fins[fn]; a={x[0]:x for x in f['anims']}[name]; return f['frames'][a[1]]
def draw(img,fr,ax,ay,K,layers=(0,1,2)):
    for (j,s,a,b,c,d,e,flip) in sorted(fr[3],key=lambda p:p[6]):
        if e not in layers: continue
        t,pal,frames=sp(j); w,h,x,y,px,m=frames[s]
        im=Image.frombytes('P',(w,h),bytes(px)); im.putpalette(pal); im=im.convert('RGBA'); mk=Image.frombytes('L',(w,h),bytes(m))
        img.paste(im,((ax+a) if flip else (ax+x+a), ay+b-h-K),mk)
base=Image.open('.re/out/png/human01.png').convert('RGBA')
cx,cy=int(sys.argv[1]),int(sys.argv[2]); K=int(sys.argv[3])
crop=base.crop((cx-260,cy-300,cx+260,cy+160)); ax,ay=260,300
items=[('HUBU','EXCOPODSTAND0'),('HUBU','BRRKPODSTAND0'),('HUBU','ROBOPODSTAND0'),('HUBU','SCNCPODSTAND0'),('HUBU','RSCHPODSTAND0'),('TOWR','TOWRSTAND0')]
for fn,n in items: draw(crop,anim(fn,n),ax,ay,K)
d=ImageDraw.Draw(crop); d.ellipse((ax-3,ay-3,ax+3,ay+3),outline=(255,0,0,255))
crop.save('.re/out/png/citytest.png')
