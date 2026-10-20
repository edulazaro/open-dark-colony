import sys,os
sys.path.insert(0,'C:/code/col/.re/py')
from spr import load_spr
from fin import load_fin
from PIL import Image, ImageDraw
root='C:/code/DCOLONY/'
cache={}
def spr(name):
    if name not in cache: cache[name]=load_spr(root+'SPRITES/'+name.upper()+'.SPR')
    return cache[name]
def frame_img(fin,fi,cell=160,model='C'):
    img=Image.new('RGBA',(cell,cell),(70,70,90,255))
    fr=fin['frames'][fi]
    for (j,s,a,b,c,d,e,flip) in sorted(fr[3],key=lambda p:p[6]):
        t,pal,frames=spr(j)
        if s>=len(frames): continue
        w,h,x,y,px,m=frames[s]
        if w<=0 or h<=0: continue
        im=Image.frombytes('P',(w,h),bytes(px)); im.putpalette(pal); im=im.convert('RGBA'); mk=Image.frombytes('L',(w,h),bytes(m))
        if flip: im=im.transpose(Image.FLIP_LEFT_RIGHT); mk=mk.transpose(Image.FLIP_LEFT_RIGHT)
        left = (a if flip else x+a); top = y+b
        if e==3: mk=mk.point(lambda v: v//2)
        img.paste(im,(cell//2+left,cell//2-60+top),mk)
    dr=ImageDraw.Draw(img); dr.line((cell//2-3,cell//2,cell//2+3,cell//2),fill=(255,0,0,255)); dr.line((cell//2,cell//2-3,cell//2,cell//2+3),fill=(255,0,0,255))
    return img
if __name__=='__main__':
    fin=load_fin(root+'ANIMATE/'+sys.argv[1]+'.FIN')
    names=sys.argv[2].split(',')
    nfr=int(sys.argv[3]) if len(sys.argv)>3 else 4
    anims={a[0]:a for a in fin['anims']}
    out=Image.new('RGBA',(160*nfr,160*len(names)))
    for r,n in enumerate(names):
        a=anims[n]
        for k in range(nfr):
            fi=min(a[1]+k,a[2]); out.paste(frame_img(fin,fi),(k*160,r*160))
    out.save('C:/code/col/.re/out/png/comp_'+sys.argv[1]+'.png'); print('ok')
